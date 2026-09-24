# MinIO dibangun dari source karena image resmi `minio/minio` sudah tidak tersedia
# di Docker Hub. Versi dipin agar build dapat diulang.
ARG GO_IMAGE=golang:1.24-alpine
ARG RUNTIME_IMAGE=alpine:3.22

FROM ${GO_IMAGE} AS build
ARG MINIO_VERSION=v0.0.0-20260212201848-7aac2a2c5b7c
ENV CGO_ENABLED=0 GOTOOLCHAIN=auto
RUN go install github.com/minio/minio@${MINIO_VERSION}

FROM ${RUNTIME_IMAGE}
# alpine sudah membawa ca-certificates-bundle dan wget (busybox) untuk healthcheck.
COPY --from=build /go/bin/minio /usr/bin/minio
EXPOSE 9000 9001
VOLUME ["/data"]
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
