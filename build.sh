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
repo_url=''
if git rev-parse --git-dir >/dev/null 2>&1; then
  commit=$(git rev-parse --short HEAD 2>/dev/null || echo 'sans commit')
  git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null || commit="${commit}*"
  # URL du dépôt déduite du remote, en https quel que soit le protocole
  # de push : une adresse SSH n'est pas ouvrable dans un navigateur.
  origin=$(git remote get-url origin 2>/dev/null || true)
  case "$origin" in
    git@*) repo_url="https://$(echo "${origin#git@}" | sed 's|:|/|')" ;;
    http*) repo_url="$origin" ;;
  esac
  repo_url="${repo_url%.git}"
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
  inline '//__I18N__'    src/i18n.js |
  inline '//__JS__'      src/app.js |
  awk -v v="$version" -v c="$commit" -v u="$repo_url" '
    { gsub(/__VERSION__/, v); gsub(/__COMMIT__/, c); gsub(/__REPO_URL__/, u); print }
  ' \
  > dist/tasks.html

printf 'dist/tasks.html — %s octets — v%s (%s)\n' \
  "$(wc -c < dist/tasks.html | tr -d ' ')" "$version" "$commit"
