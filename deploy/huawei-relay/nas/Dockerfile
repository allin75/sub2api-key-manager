ARG RELAY_BASE_IMAGE=alpine:3.22
FROM ${RELAY_BASE_IMAGE}

RUN apk add --no-cache openssh-client \
  && addgroup -g 1001 relay \
  && adduser -D -u 1000 -G relay relay

USER 1000:1001
ENTRYPOINT ["ssh"]
CMD ["-F", "/etc/relay/ssh_config", "-N", "key-manager-cloud"]
