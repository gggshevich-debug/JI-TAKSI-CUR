# Кокругление координат до 4 знаков после запятой
def round_coord(lat: int, lon: int, decimals=4):
    return round(lat, decimals), round(lon, decimals)

