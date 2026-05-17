FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends git nginx fcgiwrap spawn-fcgi socat ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY _shared/nginx.conf /etc/nginx/nginx.conf.template
COPY _shared/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
