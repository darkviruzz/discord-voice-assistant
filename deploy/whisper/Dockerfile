# whisper.cpp HTTP server — CUDA build from source.
#
# The official ghcr.io/ggml-org/whisper.cpp:*-cuda images mainly ship the CLI;
# the binary layout for `whisper-server` varies between tags. Building from
# source guarantees the server binary at a known path so the stack runs on any
# GPU instance without per-host tweaking. To use the official image instead,
# see the commented `image:`/`command:` block in deploy/docker-compose.yml.

# ── build stage ──────────────────────────────────────────────────────────────
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential cmake \
    && rm -rf /var/lib/apt/lists/*

ARG WHISPER_CPP_REF=master
RUN git clone --depth 1 --branch "${WHISPER_CPP_REF}" \
        https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src

# Static ggml/whisper libs → the only dynamic deps left are the CUDA runtime
# libraries, which are provided by the runtime base image below.
RUN cmake -B build \
        -DGGML_CUDA=ON \
        -DBUILD_SHARED_LIBS=OFF \
        -DWHISPER_BUILD_SERVER=ON \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j --config Release --target whisper-server

# ── runtime stage ────────────────────────────────────────────────────────────
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/bin/whisper-server /usr/local/bin/whisper-server

ENV WHISPER_MODEL_FILE=ggml-medium-q5_0.bin \
    WHISPER_LANGUAGE=de

EXPOSE 8080

# whisper.cpp serves its web UI on "/" (200/405 depending on build) → liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
    CMD curl -fsS -o /dev/null http://localhost:8080/ || exit 1

# Model lives on the mounted /models volume. Language/model are overridable.
CMD ["/bin/sh", "-c", "exec whisper-server --model /models/${WHISPER_MODEL_FILE} --host 0.0.0.0 --port 8080 --language ${WHISPER_LANGUAGE}"]
