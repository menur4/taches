#!/usr/bin/env bash
# Recompose le dashboard en un fichier autonome.
# Un Artifact est servi comme une page unique : CSS et JS doivent être
# inlinés, et les fontes rester en base64 (aucun fichier voisin n'est servi).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist

version=$(tr -d ' \n\r' < VERSION)

# Hash du commit construit. L'étoile signale un arbre de travail modifié :
# sans elle, un build local se ferait passer pour le commit exact.
if git rev-parse --git-dir >/dev/null 2>&1; then
  commit=$(git rev-parse --short HEAD 2>/dev/null || echo 'sans commit')
  git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null || commit="${commit}*"
else
  commit='build local'
fi

inline() {  # remplace la ligne-marqueur $1 par le contenu de $2
  awk -v marker="$1" -v src="$2" '
    $0 == marker { while ((getline line < src) > 0) print line; close(src); next }
    { print }
  '
}

< src/index.html \
  inline '<!--__FAVICON__-->' src/favicon.html |
  inline '/*__FONTS__*/' src/fonts.css |
  inline '/*__LOGO__*/'  src/logo.css |
  inline '/*__CSS__*/'   src/styles.css |
  inline '//__JS__'      src/app.js |
  awk -v v="$version" -v c="$commit" '
    { gsub(/__VERSION__/, v); gsub(/__COMMIT__/, c); print }
  ' \
  > dist/tasks.html

printf 'dist/tasks.html — %s octets — v%s (%s)\n' \
  "$(wc -c < dist/tasks.html | tr -d ' ')" "$version" "$commit"
