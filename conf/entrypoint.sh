#!/usr/bin/bash

export DEBUG="*"

service nginx start

#sleep infinity
nodemon -w functions -w functions/views -w server.js -e js,hbs server.js