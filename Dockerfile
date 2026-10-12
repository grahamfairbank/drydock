# Drydock: a container host client. The Docker CLI image provides docker,
# compose and buildx (used to deploy projects); the server itself is stdlib Python.
FROM docker:29-cli
RUN apk add --no-cache python3 git tini
WORKDIR /app
COPY drydock ./drydock
COPY web ./web
ENV PYTHONUNBUFFERED=1 PORT=9000
EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9000/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["python3", "-m", "drydock.server"]
