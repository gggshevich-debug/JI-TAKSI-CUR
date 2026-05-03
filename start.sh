clear

source /Users/mac/Desktop/JI-TAKSI-CUR/map-ven/bin/activate

brew services start redis
brew services start postgresql@15

sleep 1

PROJECT="/Users/mac/Desktop/JI-TAKSI-CUR"

# -----------------------
# OSRM
# -----------------------
echo "Starting OSRM..."

docker start osrm-az 2>/dev/null || true

if [ -z "$(docker ps -q -f name=osrm-az)" ]; then
  docker run -d \
    --name osrm-az \
    -p 9000:5000 \
    -v $PROJECT/osrm-azerbaijan:/data \
    osrm/osrm-backend \
    osrm-routed --algorithm mld /data/azerbaijan-latest.osm.osrm
fi

sleep 2

# -----------------------
# NOMINATIM
# -----------------------
echo "Starting Nominatim..."

# ❗ ВАЖНО: убиваем сломанный контейнер
docker rm -f nominatim-az 2>/dev/null || true

docker run -d \
  --name nominatim-az \
  -p 8080:8080 \
  -v $PROJECT/osm:/data \
  -v $PROJECT/nominatim-db:/var/lib/postgresql \
  -e PBF_PATH=/data/azerbaijan-260413.osm.pbf \
  -e IMPORT_STYLE=admin \
  -e THREADS=4 \
  -e OSM2PGSQL_CACHE=4096 \
  mediagis/nominatim:4.4

sleep 2

# -----------------------
# API
# -----------------------
echo "Starting API..."

uvicorn server:app \
  --reload \
  --host "localhost" \
  --port 9999 \
  --log-level info \
  --workers 1
