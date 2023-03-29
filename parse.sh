#!/bin/bash

a="$@"
node parse.js --prune --first grammar.txt "$a"
