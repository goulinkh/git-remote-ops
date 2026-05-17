#!/bin/sh
set -eu

GIT_PROJECT_ROOT="${GIT_PROJECT_ROOT:-/srv/git}"
GIT_HTTP_EXPORT_ALL="${GIT_HTTP_EXPORT_ALL:-1}"

if [ -x /usr/lib/git-core/git-http-backend ]; then
  git_http_backend=/usr/lib/git-core/git-http-backend
elif [ -x /usr/libexec/git-core/git-http-backend ]; then
  git_http_backend=/usr/libexec/git-core/git-http-backend
else
  echo "git-http-backend not found" >&2
  exit 1
fi

if [ -x /usr/sbin/fcgiwrap ]; then
  fcgiwrap=/usr/sbin/fcgiwrap
elif [ -x /usr/bin/fcgiwrap ]; then
  fcgiwrap=/usr/bin/fcgiwrap
else
  echo "fcgiwrap not found" >&2
  exit 1
fi

sed \
  -e "s#__GIT_HTTP_BACKEND__#$git_http_backend#g" \
  -e "s#__GIT_PROJECT_ROOT__#$GIT_PROJECT_ROOT#g" \
  -e "s#__GIT_HTTP_EXPORT_ALL__#$GIT_HTTP_EXPORT_ALL#g" \
  /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

spawn-fcgi -s /tmp/fcgiwrap.sock -M 766 "$fcgiwrap"
socat TCP-LISTEN:9000,fork,reuseaddr UNIX-CONNECT:/tmp/fcgiwrap.sock &
exec nginx -g 'daemon off;'
