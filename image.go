package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/coalaura/openingrouter"
)

type ImageConfig struct {
	Resolution string `json:"resolution"`
	Aspect     string `json:"aspect"`
	Quality    string `json:"quality"`
}

type ChatRequest struct {
	System string      `json:"system"`
	Prompt string      `json:"prompt"`
	Model  string      `json:"model"`
	Image  ImageConfig `json:"image"`
	Images []string    `json:"images"`
}

type ImageFrame struct {
	MIME  string `msgpack:"mime"`
	Bytes []byte `msgpack:"bytes"`
}

func (r *ChatRequest) Parse() (*openingrouter.ImageGenerationRequest, error) {
	var request openingrouter.ImageGenerationRequest

	model := GetModel(r.Model)
	if model == nil {
		return nil, fmt.Errorf("unknown model: %q", r.Model)
	}

	request.Model = r.Model

	prompt := r.Prompt

	if r.System != "" {
		if prompt != "" {
			prompt = r.System + "\n\n" + prompt
		} else {
			prompt = r.System
		}
	}

	if prompt == "" {
		return nil, errors.New("missing prompt or system")
	}

	request.Prompt = prompt

	resolution := openingrouter.ImageResolution(r.Image.Resolution)

	if len(model.Options.Resolutions) > 0 {
		request.Resolution = resolution

		if !slices.Contains(model.Options.Resolutions, string(resolution)) {
			return nil, fmt.Errorf("model does not support resolution %q", resolution)
		}
	}

	aspect := openingrouter.ImageAspectRatio(r.Image.Aspect)

	if aspect != openingrouter.ImageAspectRatioAuto && len(model.Options.AspectRatios) > 0 {
		request.AspectRatio = aspect

		if !slices.Contains(model.Options.AspectRatios, string(request.AspectRatio)) {
			return nil, fmt.Errorf("model does not support aspect ratio %q", request.AspectRatio)
		}
	}

	quality := openingrouter.ImageQuality(r.Image.Quality)

	if len(model.Options.Qualities) > 0 {
		request.Quality = quality

		if !slices.Contains(model.Options.Qualities, string(request.Quality)) {
			return nil, fmt.Errorf("model does not support quality %q", request.Quality)
		}
	}

	if len(r.Images) < model.Options.MinReferences {
		return nil, fmt.Errorf("model requires at least %d reference images", model.Options.MinReferences)
	}

	if len(r.Images) > model.Options.MaxReferences {
		return nil, fmt.Errorf("model only supports up to %d reference images", model.Options.MaxReferences)
	}

	for _, img := range r.Images {
		request.InputReferences = append(request.InputReferences, openingrouter.ContentPartImage{
			Type: openingrouter.ContentPartTypeImageURL,
			ImageURL: openingrouter.ContentPartImageURL{
				URL: img,
			},
		})
	}

	stream := model.Options.CanStream

	// openai models break when using reference images + streaming
	if len(r.Images) > 0 && strings.HasPrefix(request.Model, "openai/") {
		stream = false
	}

	request.Stream = &stream

	return &request, nil
}

func ParseChatRequest(r *http.Request) (*openingrouter.ImageGenerationRequest, error) {
	var raw ChatRequest

	err := json.NewDecoder(r.Body).Decode(&raw)
	if err != nil {
		return nil, err
	}

	request, err := raw.Parse()
	if err != nil {
		return nil, err
	}

	return request, nil
}

func HandleDump(w http.ResponseWriter, r *http.Request) {
	debug("parsing dump")

	request, err := ParseChatRequest(r)
	if err != nil {
		RespondJson(w, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})

		return
	}

	RespondJson(w, http.StatusOK, map[string]any{
		"request": request,
	})
}

func HandleImage(w http.ResponseWriter, r *http.Request) {
	debug("parsing image")

	request, err := ParseChatRequest(r)
	if err != nil {
		RespondJson(w, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})

		return
	}

	debug("preparing stream")

	ctx := r.Context()

	response, err := NewStream(w, ctx)
	if err != nil {
		RespondJson(w, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})

		return
	}

	debug("handling request")

	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				response.WriteChunk(NewChunk(ChunkAlive, nil))
			}
		}
	}()

	dump("image.json", request)

	err = RunCompletion(ctx, response, request)
	if err != nil {
		response.WriteChunk(NewChunk(ChunkError, err))

		return
	}
}

func RunCompletion(ctx context.Context, response *Stream, request *openingrouter.ImageGenerationRequest) error {
	stream, err := OpenRouterStartImageStream(ctx, *request)
	if err != nil {
		return fmt.Errorf("stream.start: %v", err)
	}

	defer stream.Close()

	var (
		hasContent bool
		cost       float64 = -1
	)

	for {
		chunk, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}

			return fmt.Errorf("stream.receive: %v", err)
		}

		if chunk.Usage != nil {
			debug("usage chunk: prompt=%d completion=%d cost=%v", chunk.Usage.PromptTokens, chunk.Usage.CompletionTokens, chunk.Usage.Cost)

			if chunk.Usage.Cost != nil {
				cost = *chunk.Usage.Cost
			}
		}

		if chunk.B64JSON != "" {
			image, err := decodeImageFrame(chunk.B64JSON)
			if err != nil {
				return err
			}

			err = response.WriteChunk(NewChunk(ChunkImage, image))
			if err != nil {
				return err
			}

			hasContent = true
		}
	}

	if !hasContent {
		return errors.New("no content returned")
	}

	if cost != -1 {
		err = response.WriteChunk(NewChunk(ChunkUsage, cost))
		if err != nil {
			return err
		}
	}

	return response.WriteChunk(NewChunk(ChunkEnd, nil))
}

func decodeImageFrame(encoded string) (*ImageFrame, error) {
	mimeType := ""

	if strings.HasPrefix(encoded, "data:") {
		header, payload, found := strings.Cut(encoded, ",")
		if !found || !strings.HasSuffix(header, ";base64") {
			return nil, errors.New("invalid image data URL")
		}

		mimeType = strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
		encoded = payload
	}

	if base64.StdEncoding.DecodedLen(len(encoded)) > MaxFrameLength-1024 {
		return nil, errors.New("image exceeds frame size limit")
	}

	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode image: %w", err)
	}

	if mimeType == "" {
		mimeType = http.DetectContentType(decoded)
	}

	return &ImageFrame{
		MIME:  mimeType,
		Bytes: decoded,
	}, nil
}
