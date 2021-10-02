DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" > /dev/null 2>&1 && pwd)"
. "$DIR/prelude.sh"

cd src

set -o errexit

activate_venv
PATH="$PATH:/data/multiversion"

# TODO: remove this file and generate tags at execution time for suites defined in multiversion/
if [ -n "${require_multiversion}" ]; then
  $python buildscripts/resmoke.py generate-multiversion-exclude-tags --oldBinVersion=last_continuous
fi
