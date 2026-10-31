package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"sync"

	"github.com/vmihailenco/msgpack/v5"
)

const (
	MaxFrameLength      = 64 * 1024 * 1024
	MaxPooledBufferSize = 1024 * 1024
)

const (
	ChunkStart ChunkType = 0
	ChunkImage ChunkType = 1
	ChunkError ChunkType = 2
	ChunkEnd   ChunkType = 3
	ChunkAlive ChunkType = 4
	ChunkUsage ChunkType = 5
)

type ChunkType uint8

type Chunk struct {
	Type ChunkType
	Data any
}

type Stream struct {
	mx  sync.Mutex
	wr  http.ResponseWriter
	ctx context.Context
}

var pool = sync.Pool{
	New: func() any {
		return &bytes.Buffer{}
	},
}

func (s *Stream) WriteChunk(chunk *Chunk) error {
	s.mx.Lock()
	defer s.mx.Unlock()

	debugIf(chunk.Type == ChunkError, "error: %v", chunk.Data)

	err := s.ctx.Err()
	if err != nil {
		return err
	}

	buf := GetFreeBuffer()
	defer releaseBuffer(buf)

	if image, ok := chunk.Data.(*ImageFrame); ok {
		buf.Grow(len(image.Bytes) + len(image.MIME) + 32)
	}

	var header [5]byte

	header[0] = byte(chunk.Type)
	buf.Write(header[:])

	if chunk.Data != nil {
		err = msgpack.NewEncoder(buf).Encode(chunk.Data)
		if err != nil {
			return err
		}
	}

	length := buf.Len() - len(header)
	if length > MaxFrameLength {
		return errors.New("image frame exceeds size limit")
	}

	binary.LittleEndian.PutUint32(buf.Bytes()[1:5], uint32(length))

	written, err := s.wr.Write(buf.Bytes())
	if err != nil {
		return err
	}

	if written != buf.Len() {
		return io.ErrShortWrite
	}

	flusher, ok := s.wr.(http.Flusher)
	if !ok {
		return errors.New("failed to create flusher")
	}

	select {
	case <-s.ctx.Done():
		return s.ctx.Err()
	default:
		flusher.Flush()

		return nil
	}
}

func GetFreeBuffer() *bytes.Buffer {
	buf := pool.Get().(*bytes.Buffer)

	buf.Reset()

	return buf
}

func NewStream(w http.ResponseWriter, ctx context.Context) (*Stream, error) {
	w.Header().Set("Content-Type", "application/x-paws-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")

	return &Stream{
		wr:  w,
		ctx: ctx,
	}, nil
}

func NewChunk(typ ChunkType, data any) *Chunk {
	if err, ok := data.(error); ok {
		data = err.Error()
	}

	return &Chunk{
		Type: typ,
		Data: data,
	}
}

func GetErrorMessage(err error) string {
	return err.Error()
}

func releaseBuffer(buf *bytes.Buffer) {
	// Do not keep multi-megabyte image frames alive between requests.
	if buf.Cap() <= MaxPooledBufferSize {
		pool.Put(buf)
	}
}
