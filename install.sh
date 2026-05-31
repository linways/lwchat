#!/usr/bin/env sh
# lwchat installer — convenience entry point.
#
# Usage:
#   ./install.sh                # install (default)
#   ./install.sh update         # pull latest + re-link binary + refresh skill
#   ./install.sh status         # what's installed where
#   ./install.sh install-skill  # snapshot + symlink skill only
#   ./install.sh update-skill   # alias for install-skill
#   ./install.sh uninstall      # remove links + npm unlink (preserves ~/.lwchat/)
#
# install.mjs is the real implementation. This wrapper exists so that
# a fresh clone has a one-line, no-argument-to-remember install entry
# (`./install.sh`) matching common OSS convention. The mjs path
# (`node install.mjs <cmd>`) continues to work for anyone who prefers it.

set -e
cd "$(dirname "$0")"

if [ $# -eq 0 ]; then
  exec node install.mjs install
else
  exec node install.mjs "$@"
fi
