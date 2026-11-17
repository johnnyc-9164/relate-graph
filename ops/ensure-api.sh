#!/bin/bash
# Recovery for the main Relate graph API. The full-stack heal (all graphs +
# Ollama) lives in ensure-all.sh — this entry point is kept because runbooks
# and the relate-graph-bot name it. It delegates, then re-checks Main.
exec ~/workspace/relate-space/ensure-all.sh
