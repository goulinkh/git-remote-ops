FROM alpine:3.20

RUN apk add --no-cache git git-daemon nginx fcgiwrap spawn-fcgi socat
COPY _shared/nginx.conf /etc/nginx/nginx.conf.template
COPY _shared/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
