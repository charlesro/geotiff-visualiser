import React, { useState } from 'react';
import { X, Play, Copy, Check, Terminal, Database, Loader2, Map as MapIcon, BarChart3, ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { parse } from 'wellknown';
import { cn } from '../lib/utils';
import { isTsColumn, parseTsColumn, getTsMetrics } from '../lib/timeseries';
import { normalizeLocalUrl, listLocalFiles, runLocalQuery, localFileUrl } from '../services/local-server';
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, Legend } from 'recharts';

const PYTHON_SCRIPT = `import os
import math
import json
import uuid
import threading
import traceback
from collections import defaultdict
from datetime import datetime

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from werkzeug.utils import safe_join, secure_filename

os.environ["GDAL_HTTP_MERGE_CONSECUTIVE_RANGES"] = "YES"
os.environ["GDAL_HTTP_MAX_RETRY"] = "5"
os.environ["GDAL_HTTP_RETRY_DELAY"] = "2"
os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"
os.environ["CPL_VSIL_CURL_CHUNK_SIZE"] = "1048576"
os.environ["VSI_CACHE"] = "YES"
os.environ["VSI_CACHE_SIZE"] = "52428800"

import numpy as np
import requests

try:
    import duckdb
    HAS_DUCKDB = True
except ImportError:
    HAS_DUCKDB = False

try:
    import rasterio
    from rasterio.windows import from_bounds, Window
    from rasterio.warp import transform_bounds, reproject, Resampling
    from rasterio.transform import from_bounds as transform_from_bounds
    from rasterio.crs import CRS
    HAS_GEO_DEPS = True
except ImportError:
    HAS_GEO_DEPS = False


app = Flask(__name__)

CORS(app, resources={r"/*": {
    "origins": "*",
    "expose_headers": ["Content-Range", "Accept-Ranges", "Content-Length"]
}})

DATA_DIR = os.path.abspath(os.environ.get("DATA_DIR", "./data_cache"))
os.makedirs(DATA_DIR, exist_ok=True)

STAC_URL = os.environ.get("STAC_URL", "https://earth-search.aws.element84.com/v1/search")
STAC_COLLECTION = os.environ.get("STAC_COLLECTION", "sentinel-2-l2a")

db_lock = threading.Lock()

if HAS_DUCKDB:
    db = duckdb.connect("local.db")


S2_ASSET_ALIASES = {
    "B01": ["B01", "coastal", "coastal-aerosol"],
    "B02": ["B02", "blue"],
    "B03": ["B03", "green"],
    "B04": ["B04", "red"],
    "B05": ["B05", "rededge1", "red-edge-1"],
    "B06": ["B06", "rededge2", "red-edge-2"],
    "B07": ["B07", "rededge3", "red-edge-3"],
    "B08": ["B08", "nir"],
    "B8A": ["B8A", "nir08", "nir-narrow"],
    "B09": ["B09", "water-vapor", "wvp"],
    "B11": ["B11", "swir16", "swir1"],
    "B12": ["B12", "swir22", "swir2"],
    "SCL": ["SCL", "scl"],
    "AOT": ["AOT", "aot"],
    "WVP": ["WVP", "wvp"]
}


def clean_value(val):
    if isinstance(val, (int, str, bool, type(None))):
        return val
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            return None
        return val
    return str(val)


def validate_bbox(bbox):
    if not isinstance(bbox, list) or len(bbox) != 4:
        raise ValueError("bbox must be [min_lng, min_lat, max_lng, max_lat]")

    if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in bbox):
        raise ValueError("bbox values must be finite numbers")

    left, bottom, right, top = map(float, bbox)

    if left >= right:
        raise ValueError("bbox min_lng must be smaller than max_lng")
    if bottom >= top:
        raise ValueError("bbox min_lat must be smaller than max_lat")
    if left < -180 or right > 180 or bottom < -90 or top > 90:
        raise ValueError("bbox must be WGS84 longitude/latitude")

    return left, bottom, right, top


def validate_date(date_str, name):
    try:
        return datetime.strptime(date_str, "%Y-%m-%d").date()
    except Exception:
        raise ValueError(f"{name} must be YYYY-MM-DD")


def sanitize_item_id(item_id):
    item_id = secure_filename(str(item_id or "").strip())
    item_id = os.path.splitext(item_id)[0]
    if not item_id:
        item_id = f"job_{uuid.uuid4().hex[:12]}"
    return item_id


def rounded_window_from_bounds(left, bottom, right, top, transform):
    win = from_bounds(left, bottom, right, top, transform)

    col_start = math.floor(win.col_off)
    row_start = math.floor(win.row_off)
    col_stop = math.ceil(win.col_off + win.width)
    row_stop = math.ceil(win.row_off + win.height)

    return Window(
        int(col_start),
        int(row_start),
        int(col_stop - col_start),
        int(row_stop - row_start)
    )


def utm_crs_from_bbox(left, bottom, right, top):
    lon = (left + right) / 2
    lat = (bottom + top) / 2
    zone = int((lon + 180) // 6) + 1
    epsg = 32600 + zone if lat >= 0 else 32700 + zone
    return CRS.from_epsg(epsg)


def normalize_bands(bands):
    if not bands:
        return ["B04", "B03", "B02", "B08"]

    out = []

    for band in bands:
        band = str(band).strip()
        if not band:
            continue

        b = band.upper()

        if b == "B8A":
            out.append("B8A")
        elif b in S2_ASSET_ALIASES:
            out.append(b)
        else:
            out.append(band)

    if not out:
        raise ValueError("No valid bands requested")

    return out


def href_to_rasterio_url(href):
    if href.startswith("s3://"):
        raise ValueError(f"Asset is S3-only and cannot be opened as HTTPS by this script: {href}")
    return href


def asset_href(item, band):
    assets = item.get("assets", {})
    aliases = S2_ASSET_ALIASES.get(band, [band])

    for key in aliases:
        if key in assets and "href" in assets[key]:
            return href_to_rasterio_url(assets[key]["href"])

    available = ", ".join(sorted(assets.keys()))
    raise ValueError(f"Band {band} not found in STAC item. Available assets: {available}")


def item_datetime(item):
    return item.get("properties", {}).get("datetime")


def item_date(item):
    dt = item_datetime(item)
    if not dt:
        return "unknown_date"
    return dt[:10]


def item_cloud_cover(item):
    cc = item.get("properties", {}).get("eo:cloud_cover")
    try:
        return float(cc)
    except Exception:
        return 9999.0


def stac_search_sentinel2(bbox, start_date, end_date, max_cloud_cover=100, limit=100):
    left, bottom, right, top = bbox

    payload = {
        "collections": [STAC_COLLECTION],
        "bbox": [left, bottom, right, top],
        "datetime": f"{start_date}T00:00:00Z/{end_date}T23:59:59Z",
        "limit": limit
    }

    items = []
    url = STAC_URL

    while url:
        response = requests.post(url, json=payload, timeout=60)

        if not response.ok:
            print("STAC request failed")
            print("URL:", url)
            print("Payload:", json.dumps(payload, indent=2) if payload else None)
            print("Status:", response.status_code)
            print("Response:", response.text)
            response.raise_for_status()

        data = response.json()

        for item in data.get("features", []):
            if item_cloud_cover(item) <= max_cloud_cover:
                items.append(item)

        next_url = None
        next_body = None

        for link in data.get("links", []):
            if link.get("rel") == "next":
                next_url = link.get("href")
                next_body = link.get("body")
                break

        if next_url:
            url = next_url
            payload = next_body if next_body else payload
        else:
            url = None

    items.sort(key=lambda x: (item_date(x), item_cloud_cover(x), item_datetime(x) or ""))

    return items


def build_date_groups(items, requested_bands):
    groups = defaultdict(list)

    for item in items:
        ok = True

        for band in requested_bands:
            try:
                asset_href(item, band)
            except Exception:
                ok = False
                break

        if ok:
            groups[item_date(item)].append(item)

    for date in groups:
        groups[date].sort(key=lambda x: item_cloud_cover(x))

    return dict(sorted(groups.items()))


def select_evenly_spaced_dates(groups, n_dates):
    if n_dates is None:
        return groups

    n_dates = int(n_dates)

    if n_dates <= 0:
        raise ValueError("n_dates must be > 0")

    dates = list(groups.keys())

    if len(dates) <= n_dates:
        return groups

    if n_dates == 1:
        selected_dates = [dates[len(dates) // 2]]
    else:
        selected_dates = []
        for i in range(n_dates):
            idx = round(i * (len(dates) - 1) / (n_dates - 1))
            selected_dates.append(dates[idx])

    return {date: groups[date] for date in selected_dates}


def create_output_grid(bbox, target_crs, resolution):
    left, bottom, right, top = bbox

    dst_left, dst_bottom, dst_right, dst_top = transform_bounds(
        "EPSG:4326",
        target_crs,
        left,
        bottom,
        right,
        top,
        densify_pts=21
    )

    dst_width = max(1, int(math.ceil((dst_right - dst_left) / resolution)))
    dst_height = max(1, int(math.ceil((dst_top - dst_bottom) / resolution)))

    max_dim = 6000
    scale = 1.0

    if dst_width > max_dim or dst_height > max_dim:
        scale = max(dst_width / max_dim, dst_height / max_dim)
        dst_width = max(1, int(round(dst_width / scale)))
        dst_height = max(1, int(round(dst_height / scale)))
        print(f"Requested raster too large. Downsampling by {scale:.2f}x to {dst_width}x{dst_height}")

    dst_transform = transform_from_bounds(
        dst_left,
        dst_bottom,
        dst_right,
        dst_top,
        dst_width,
        dst_height
    )

    return dst_width, dst_height, dst_transform, scale


def open_reference_asset(items, bands):
    last_error = None

    for item in items:
        for band in bands:
            try:
                href = asset_href(item, band)
                src = rasterio.open(href)
                return src, band, href
            except Exception as e:
                last_error = e

    raise ValueError(f"Could not open any reference asset: {last_error}")


def merge_date_to_raster(date, items, bbox, bands, out_path, resolution=10, resampling_name="bilinear"):
    target_crs = utm_crs_from_bbox(*bbox)

    ref_src, ref_band, ref_href = open_reference_asset(items, bands)

    try:
        ref_dtype = ref_src.dtypes[0]
        ref_nodata = ref_src.nodata if ref_src.nodata is not None else 0
    finally:
        ref_src.close()

    dst_width, dst_height, dst_transform, scale = create_output_grid(
        bbox,
        target_crs,
        resolution
    )

    resampling = Resampling.nearest if resampling_name == "nearest" else Resampling.bilinear

    processed_bands = {}

    for band in bands:
        print(f"[{date}] Processing band {band} using {len(items)} scene(s)")

        dst_nodata = ref_nodata
        dst_data = np.full((dst_height, dst_width), dst_nodata, dtype=ref_dtype)

        for item in items:
            try:
                href = asset_href(item, band)

                with rasterio.open(href) as src:
                    src_nodata = src.nodata if src.nodata is not None else dst_nodata

                    tile_bounds = transform_bounds(
                        "EPSG:4326",
                        src.crs,
                        bbox[0],
                        bbox[1],
                        bbox[2],
                        bbox[3],
                        densify_pts=21
                    )

                    tile_left = min(tile_bounds[0], tile_bounds[2])
                    tile_bottom = min(tile_bounds[1], tile_bounds[3])
                    tile_right = max(tile_bounds[0], tile_bounds[2])
                    tile_top = max(tile_bounds[1], tile_bounds[3])

                    src_left, src_bottom, src_right, src_top = src.bounds

                    if (
                        tile_right < src_left or
                        tile_left > src_right or
                        tile_top < src_bottom or
                        tile_bottom > src_top
                    ):
                        continue

                    raw_win = rounded_window_from_bounds(
                        tile_left,
                        tile_bottom,
                        tile_right,
                        tile_top,
                        src.transform
                    )

                    img_win = Window(0, 0, src.width, src.height)

                    try:
                        intersect_win = raw_win.intersection(img_win)
                    except Exception:
                        continue

                    if intersect_win.width <= 0 or intersect_win.height <= 0:
                        continue

                    read_width = max(1, int(round(intersect_win.width / scale)))
                    read_height = max(1, int(round(intersect_win.height / scale)))

                    src_data = src.read(
                        1,
                        window=intersect_win,
                        out_shape=(read_height, read_width)
                    )

                    curr_left, curr_bottom, curr_right, curr_top = rasterio.windows.bounds(
                        intersect_win,
                        src.transform
                    )

                    src_transform = transform_from_bounds(
                        curr_left,
                        curr_bottom,
                        curr_right,
                        curr_top,
                        read_width,
                        read_height
                    )

                    temp_dst = np.full_like(dst_data, dst_nodata)

                    try:
                        reproject(
                            source=src_data,
                            destination=temp_dst,
                            src_transform=src_transform,
                            src_crs=src.crs,
                            dst_transform=dst_transform,
                            dst_crs=target_crs,
                            resampling=resampling,
                            src_nodata=src_nodata,
                            dst_nodata=dst_nodata,
                            init_dest=dst_nodata
                        )
                    except Exception as e:
                        print(f"[{date}] {band}: {resampling_name} failed, retrying nearest: {e}")

                        temp_dst = np.full_like(dst_data, dst_nodata)

                        reproject(
                            source=src_data,
                            destination=temp_dst,
                            src_transform=src_transform,
                            src_crs=src.crs,
                            dst_transform=dst_transform,
                            dst_crs=target_crs,
                            resampling=Resampling.nearest,
                            src_nodata=src_nodata,
                            dst_nodata=dst_nodata,
                            init_dest=dst_nodata
                        )

                    valid_mask = temp_dst != dst_nodata
                    empty_mask = dst_data == dst_nodata
                    write_mask = valid_mask & empty_mask

                    np.copyto(dst_data, temp_dst, where=write_mask)

                    print(
                        f"[{date}] {band}: wrote {int(write_mask.sum())} px "
                        f"from {item.get('id', 'unknown')}, cloud={item_cloud_cover(item)}"
                    )

            except Exception as e:
                print(f"[{date}] Warning: failed item for band {band}: {e}")
                traceback.print_exc()

        processed_bands[band] = dst_data

    profile = {
        "driver": "GTiff",
        "height": dst_height,
        "width": dst_width,
        "count": len(bands),
        "dtype": ref_dtype,
        "crs": target_crs,
        "transform": dst_transform,
        "compress": "deflate",
        "nodata": ref_nodata,
        "tiled": dst_width >= 256 and dst_height >= 256
    }

    if profile["tiled"]:
        profile["blockxsize"] = 256
        profile["blockysize"] = 256

    tmp_path = out_path + ".tmp"

    if os.path.exists(tmp_path):
        os.remove(tmp_path)

    with rasterio.open(tmp_path, "w", **profile) as dst:
        for idx, band in enumerate(bands, start=1):
            dst.write(processed_bands[band], idx)
            dst.set_band_description(idx, band)

        dst.update_tags(
            source="Earth Search STAC / Sentinel-2 L2A",
            date=date,
            bands=",".join(bands),
            bbox_wgs84=json.dumps(list(bbox)),
            resolution_m=str(resolution)
        )

    os.replace(tmp_path, out_path)

    return {
        "date": date,
        "filename": os.path.basename(out_path),
        "width": dst_width,
        "height": dst_height,
        "bands": bands,
        "scene_count": len(items),
        "crs": str(target_crs),
        "resolution_m": resolution
    }


@app.route("/", methods=["GET"])
def index():
    return "DuckDB & Sentinel-2 Mosaic Engine Running"


@app.route("/files", methods=["GET"])
def list_files():
    files = []

    for root, _, filenames in os.walk(DATA_DIR):
        for filename in filenames:
            if filename.lower().endswith((".tif", ".tiff", ".zip", ".parquet")):
                rel_dir = os.path.relpath(root, DATA_DIR)
                if rel_dir == ".":
                    files.append(filename)
                else:
                    files.append(os.path.join(rel_dir, filename).replace("\\\\", "/"))

    return jsonify(files)


@app.route("/files/<path:filename>", methods=["GET"])
def serve_file(filename):
    file_path = safe_join(DATA_DIR, filename)

    if file_path is None or not os.path.exists(file_path):
        return "File not found", 404

    return send_file(file_path, conditional=True)


@app.route("/query", methods=["OPTIONS", "POST"])
def query():
    if request.method == "OPTIONS":
        return "", 204

    try:
        if not HAS_DUCKDB:
            return jsonify({"status": "error", "message": "DuckDB not installed"}), 500

        data = request.get_json(silent=True) or {}
        sql = data.get("query")

        if not sql:
            return jsonify({"status": "error", "message": "No query provided"}), 400

        with db_lock:
            res = db.execute(sql)

            columns = []
            if res.description:
                columns = [desc[0] for desc in res.description]

            rows = []
            for row in res.fetchall():
                row_dict = {}
                for i, col in enumerate(columns):
                    row_dict[col] = clean_value(row[i])
                rows.append(row_dict)

        return jsonify({
            "status": "success",
            "columns": columns,
            "rows": rows
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/status", methods=["GET"])
def get_status():
    return jsonify({
        "status": "online",
        "has_geo_deps": HAS_GEO_DEPS,
        "has_duckdb": HAS_DUCKDB,
        "cache_dir": DATA_DIR,
        "stac_url": STAC_URL,
        "stac_collection": STAC_COLLECTION
    })


@app.route("/api/search_sentinel2", methods=["OPTIONS", "POST"])
def search_sentinel2():
    if request.method == "OPTIONS":
        return "", 204

    try:
        data = request.get_json(silent=True) or {}

        bbox = validate_bbox(data.get("bbox"))
        start_date = validate_date(data.get("start_date"), "start_date")
        end_date = validate_date(data.get("end_date"), "end_date")

        if start_date > end_date:
            raise ValueError("start_date must be before or equal to end_date")

        bands = normalize_bands(data.get("bands"))
        max_cloud_cover = float(data.get("max_cloud_cover", 100))
        n_dates = data.get("n_dates")

        items = stac_search_sentinel2(
            bbox=bbox,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            max_cloud_cover=max_cloud_cover
        )

        all_groups = build_date_groups(items, bands)
        selected_groups = select_evenly_spaced_dates(all_groups, n_dates)

        dates = []
        for date, date_items in selected_groups.items():
            dates.append({
                "date": date,
                "scene_count": len(date_items),
                "mean_cloud_cover": sum(item_cloud_cover(i) for i in date_items) / len(date_items),
                "item_ids": [i.get("id") for i in date_items]
            })

        return jsonify({
            "status": "success",
            "bbox": list(bbox),
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "bands": bands,
            "max_cloud_cover": max_cloud_cover,
            "n_dates": int(n_dates) if n_dates is not None else None,
            "available_date_count": len(all_groups),
            "selected_date_count": len(dates),
            "total_items_after_cloud_filter": len(items),
            "dates": dates
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/api/process_sentinel2_dates", methods=["OPTIONS", "POST"])
def process_sentinel2_dates():
    if request.method == "OPTIONS":
        return "", 204

    if not HAS_GEO_DEPS:
        return jsonify({"status": "error", "error": "Missing geospatial dependencies"}), 500

    try:
        data = request.get_json(silent=True) or {}

        job_id = sanitize_item_id(data.get("id"))
        bbox = validate_bbox(data.get("bbox"))

        start_date = validate_date(data.get("start_date"), "start_date")
        end_date = validate_date(data.get("end_date"), "end_date")

        if start_date > end_date:
            raise ValueError("start_date must be before or equal to end_date")

        bands = normalize_bands(data.get("bands"))
        max_cloud_cover = float(data.get("max_cloud_cover", 100))
        resolution = float(data.get("resolution", 10))
        resampling = str(data.get("resampling", "bilinear")).lower()
        n_dates = data.get("n_dates")

        print(
            f"[{job_id}] Searching Sentinel-2: "
            f"bbox={bbox}, dates={start_date}/{end_date}, "
            f"bands={bands}, cloud<={max_cloud_cover}, n_dates={n_dates}"
        )

        items = stac_search_sentinel2(
            bbox=bbox,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            max_cloud_cover=max_cloud_cover
        )

        all_groups = build_date_groups(items, bands)
        selected_groups = select_evenly_spaced_dates(all_groups, n_dates)

        if not selected_groups:
            return jsonify({
                "status": "success",
                "message": "No Sentinel-2 items found for this bbox/date range/band/cloud selection",
                "results": []
            })

        results = []

        for date, date_items in selected_groups.items():
            out_filename = secure_filename(f"{job_id}_{date}.tif")
            out_path = os.path.join(DATA_DIR, out_filename)

            if os.path.exists(out_path):
                print(f"[{job_id}] Reusing cached raster for {date}: {out_filename}")
                result = {
                    "date": date,
                    "filename": out_filename,
                    "scene_count": len(date_items),
                    "bands": bands,
                    "cached": True
                }
            else:
                result = merge_date_to_raster(
                    date=date,
                    items=date_items,
                    bbox=bbox,
                    bands=bands,
                    out_path=out_path,
                    resolution=resolution,
                    resampling_name=resampling
                )
                result["cached"] = False

            result["url"] = f"{request.host_url}files/{out_filename}"
            result["item_ids"] = [i.get("id") for i in date_items]
            result["cloud_covers"] = [item_cloud_cover(i) for i in date_items]

            results.append(result)

        return jsonify({
            "status": "success",
            "job_id": job_id,
            "bbox": list(bbox),
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "bands": bands,
            "max_cloud_cover": max_cloud_cover,
            "resolution": resolution,
            "n_dates": int(n_dates) if n_dates is not None else None,
            "available_date_count": len(all_groups),
            "selected_date_count": len(selected_groups),
            "results": results
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/api/process_bands", methods=["OPTIONS", "POST"])
def process_bands_legacy_name():
    return process_sentinel2_dates()


if __name__ == "__main__":
    print("Starting Sentinel-2 Local Mosaic Engine on port 8080...")

    if not HAS_GEO_DEPS or not HAS_DUCKDB:
        print("WARNING: Missing libraries. Run:")
        print("pip install flask flask-cors rasterio pyproj numpy duckdb requests")

    app.run(port=8080, debug=False, threaded=True)
`;

export const LocalPythonServerModal = ({ 
  isOpen, 
  onClose, 
  onAddVectorLayer, 
  onAddRemoteRasterLayer, 
  localUrl, 
  setLocalUrl,
  useLocalServer,
  setUseLocalServer
}: { 
  isOpen: boolean, 
  onClose: () => void, 
  onAddVectorLayer: (name: string, geojson: any) => void, 
  onAddRemoteRasterLayer?: (url: string, name: string) => void, 
  localUrl: string, 
  setLocalUrl: (url: string) => void,
  useLocalServer: boolean,
  setUseLocalServer: (val: boolean) => void
}) => {
  const normalizedLocalUrl = normalizeLocalUrl(localUrl);

  const defaultQuery = `INSTALL spatial;
LOAD spatial;

-- ------------------------------------------------------------
-- Parameters: modify only this block
-- ------------------------------------------------------------

SET threads TO 8;

CREATE OR REPLACE TEMP TABLE params AS
SELECT
  'Maïs ensilage'::VARCHAR AS species_1,
  'Luzerne'::VARCHAR AS species_2,
  0.0001::DOUBLE AS neighbor_distance,
  100::INTEGER AS max_pairs;


-- ------------------------------------------------------------
-- 1. Create one row per field
-- ------------------------------------------------------------

CREATE OR REPLACE TABLE fields_unique AS
SELECT
  NewID,
  any_value(crp_lbl) AS crp_lbl,
  any_value(geometry) AS geometry_wkt,
  ST_GeomFromText(any_value(geometry)) AS geom
FROM read_parquet('/Users/charles/Documents/These/data_full_melted.parquet')
WHERE geometry IS NOT NULL
  AND crp_lbl IN (
    (SELECT species_1 FROM params),
    (SELECT species_2 FROM params)
  )
GROUP BY NewID;


CREATE INDEX IF NOT EXISTS fields_unique_geom_idx
ON fields_unique
USING RTREE (geom);


-- ------------------------------------------------------------
-- 2. Find neighboring pairs, then keep only max_pairs
-- ------------------------------------------------------------

CREATE OR REPLACE TABLE neighbor_pairs AS
WITH candidate_pairs AS (
  SELECT
    a.NewID AS field_id_1,
    a.crp_lbl AS species_1,
    b.NewID AS field_id_2,
    b.crp_lbl AS species_2,
    ST_Distance(a.geom, b.geom) AS distance,
    a.geometry_wkt AS geometry_wkt_1,
    b.geometry_wkt AS geometry_wkt_2
  FROM fields_unique a
  JOIN fields_unique b
    ON a.crp_lbl = (SELECT species_1 FROM params)
   AND b.crp_lbl = (SELECT species_2 FROM params)
   AND ST_DWithin(
        a.geom,
        b.geom,
        (SELECT neighbor_distance FROM params)
   )
)
SELECT *
FROM candidate_pairs
ORDER BY distance
LIMIT (SELECT max_pairs FROM params);


-- ------------------------------------------------------------
-- 3. Inspect neighboring pairs
-- ------------------------------------------------------------

SELECT *
FROM neighbor_pairs
ORDER BY distance
LIMIT 20;


-- ------------------------------------------------------------
-- 4. Long-format table: one row per field per pair
-- ------------------------------------------------------------

CREATE OR REPLACE TABLE neighbor_fields_long AS
SELECT
  CAST(field_id_1 AS VARCHAR) || '_' || CAST(field_id_2 AS VARCHAR) AS pair_id,
  field_id_1 AS NewID,
  species_1 AS crp_lbl,
  'species_1' AS role_in_pair,
  field_id_2 AS neighbor_id,
  species_2 AS neighbor_crp_lbl,
  distance,
  geometry_wkt_1 AS geometry_wkt
FROM neighbor_pairs

UNION ALL

SELECT
  CAST(field_id_1 AS VARCHAR) || '_' || CAST(field_id_2 AS VARCHAR) AS pair_id,
  field_id_2 AS NewID,
  species_2 AS crp_lbl,
  'species_2' AS role_in_pair,
  field_id_1 AS neighbor_id,
  species_1 AS neighbor_crp_lbl,
  distance,
  geometry_wkt_2 AS geometry_wkt
FROM neighbor_pairs;


-- ------------------------------------------------------------
-- 5. Join back to full time-series data
-- ------------------------------------------------------------

CREATE OR REPLACE TABLE neighbor_timeseries AS
SELECT
  nf.pair_id,
  nf.role_in_pair,
  nf.neighbor_id,
  nf.neighbor_crp_lbl,
  nf.distance,
  d.*
FROM neighbor_fields_long nf
JOIN read_parquet('/Users/charles/Documents/These/data_full_melted.parquet') d
  ON d.NewID = nf.NewID;


-- ------------------------------------------------------------
-- 6. Inspect final output
-- ------------------------------------------------------------

SELECT *
FROM neighbor_timeseries
ORDER BY pair_id, NewID
LIMIT 50;


-- ------------------------------------------------------------
-- 7. Export final result
-- ------------------------------------------------------------

COPY neighbor_timeseries
TO '/Users/charles/Documents/These/neighbor_timeseries.parquet'
(FORMAT PARQUET);`;

  const [query, setQuery] = useState(defaultQuery);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  
  const [activeTab, setActiveTab] = useState<'sql' | 'files'>('files');
  const [files, setFiles] = useState<string[]>([]);
  const [fetchingFiles, setFetchingFiles] = useState(false);

  // Added fetch files method
  const handleFetchFiles = async () => {
    setFetchingFiles(true);
    setError(null);
    try {
      const data = await listLocalFiles(localUrl);
      setFiles(data);
    } catch (err: any) {
      setError(err.message || 'Failed to connect. Make sure Python server is running.');
    } finally {
      setFetchingFiles(false);
    }
  };

  const handleImportFile = (filename: string) => {
    if (onAddRemoteRasterLayer) {
      onAddRemoteRasterLayer(`${localFileUrl(localUrl, filename)}?bypass_ngrok=true`, filename);
      onClose();
    }
  };

  // Time-series property helpers are shared — see lib/timeseries.ts.
  const getChartData = (row: any, tsCols: string[]) => {
    const dataByDate: Record<string, any> = {};
    for (const c of tsCols) {
      const parsed = parseTsColumn(c);
      if (parsed) {
        if (!dataByDate[parsed.date]) dataByDate[parsed.date] = { date: parsed.date };
        if (row[c] !== null && row[c] !== undefined) {
          dataByDate[parsed.date][parsed.metric] = row[c];
        }
      }
    }
    return Object.values(dataByDate).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  };

  const tsCols = result?.columns?.filter(isTsColumn) || [];
  const standardCols = result?.columns?.filter((c: string) => !isTsColumn(c)) || [];
  const metricsList = getTsMetrics(tsCols);
  const COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

  const handleCopy = () => {
    navigator.clipboard.writeText(PYTHON_SCRIPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAddGeometryToMap = () => {
    if (!result || !result.rows || result.rows.length === 0) return;
    
    const features = result.rows.map((row: any, i: number) => {
      let geom = null;
      for (const c of result.columns) {
        if (typeof row[c] === 'string' && (row[c].startsWith('POLYGON') || row[c].startsWith('MULTIPOLYGON') || row[c].startsWith('POINT') || row[c].startsWith('LINESTRING'))) {
           try {
             geom = parse(row[c]);
             break;
           } catch(e) {}
        }
      }
      
      if (geom) {
         return {
            type: "Feature",
            geometry: geom,
            properties: { ...row, id: i }
         }
      }
      return null;
    }).filter(Boolean);

    if (features.length > 0) {
       const geojson = { type: "FeatureCollection", features };
       onAddVectorLayer('DuckDB Query Geometries', geojson);
       onClose();
    } else {
       setError('No geometries found in the results.');
    }
  };

  const handleExecute = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await runLocalQuery(localUrl, query);
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Failed to connect to local server. Make sure it is running.');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-[95vw] max-w-[1800px] bg-[#111] border border-white/10 rounded-2xl shadow-2xl flex flex-col h-[95vh] max-h-[1400px]"
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-orange-500" />
            <h2 className="text-lg font-medium text-white">Local Python Server Mode</h2>
          </div>
          <button onClick={onClose} className="p-1 text-white/50 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="flex flex-col flex-1 overflow-hidden p-4">
          {showScript && (
            <div className="space-y-4 mb-4 p-4 border border-white/10 rounded-xl bg-white/5 shrink-0">
              <div className="flex justify-between items-center">
                <p className="text-white/80 text-sm">
                  To bypass browser WebAssembly memory limits, run this Python server locally.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleCopy}
                    className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded text-xs text-white transition-colors flex items-center gap-1"
                  >
                    {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button onClick={() => setShowScript(false)} className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded text-xs text-white transition-colors">
                    Close
                  </button>
                </div>
              </div>
              <div className="p-3 bg-black/40 border border-white/10 rounded-lg">
                <p className="text-xs text-white/50 mb-1 font-mono">1. Install dependencies</p>
                <code className="text-white/90 text-sm font-mono">pip install flask flask-cors rasterio pyproj numpy duckdb requests</code>
              </div>
              <div className="p-3 bg-black/40 border border-white/10 rounded-lg">
                <p className="text-xs text-white/50 mb-1 font-mono">2. Save as server.py and run</p>
                <pre className="bg-[#050505] p-3 rounded-lg border border-white/10 overflow-x-auto text-xs text-green-400 font-mono mt-2 max-h-48">
                  <code>{PYTHON_SCRIPT}</code>
                </pre>
              </div>
            </div>
          )}

          <div className="flex gap-4 items-end mb-4 shrink-0 border-b border-white/10 pb-4">
            <div className="flex-1 max-w-sm">
              <label className="block text-xs text-white/50 mb-1">Local Server URL</label>
              <input
                id="local-server-url-input"
                type="text"
                value={localUrl}
                onChange={(e) => setLocalUrl(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500"
              />
            </div>
            {!showScript && (
              <button onClick={() => setShowScript(true)} className="px-3 py-2 border border-white/10 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-white/70 hover:text-white transition-colors">
                View Python Setup Script
              </button>
            )}
            <div className="flex bg-black/40 border border-white/10 rounded-lg p-2.5 items-center gap-2">
              <input
                id="use-local-server-checkbox"
                type="checkbox"
                checked={useLocalServer}
                onChange={(e) => setUseLocalServer(e.target.checked)}
                className="w-4 h-4 rounded border-white/20 bg-black/40 text-orange-500 focus:ring-orange-500/50 focus:ring-offset-0 focus:ring-1 cursor-pointer"
              />
              <label htmlFor="use-local-server-checkbox" className="text-xs font-medium text-white/80 cursor-pointer select-none">
                Enable Local Python Engine
              </label>
            </div>
            <div className="flex-1" />
            <div className="flex bg-black/40 border border-white/10 rounded-lg p-1">
               <button
                 onClick={() => setActiveTab('files')}
                 className={cn("px-4 py-1.5 rounded-md text-sm transition-colors", activeTab === 'files' ? "bg-white/10 text-white font-medium" : "text-white/50 hover:text-white")}
               >
                 Local GeoTIFF Files
               </button>
               <button
                 onClick={() => setActiveTab('sql')}
                 className={cn("px-4 py-1.5 rounded-md text-sm transition-colors", activeTab === 'sql' ? "bg-white/10 text-white font-medium" : "text-white/50 hover:text-white")}
               >
                 DuckDB SQL Engine
               </button>
            </div>
          </div>

          <div className="flex flex-col flex-1 overflow-hidden">
            {activeTab === 'files' ? (
              <div className="flex flex-col h-full bg-black/20 border border-white/10 rounded-lg overflow-hidden p-4">
                 <div className="flex justify-between items-center mb-4">
                    <p className="text-sm text-white/70">Local files served from <code className="text-orange-400 bg-orange-400/10 px-1 rounded ml-1">DATA_DIR</code></p>
                    <button
                      onClick={handleFetchFiles}
                      disabled={fetchingFiles}
                      className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 rounded text-sm text-white font-medium transition-all"
                    >
                      {fetchingFiles ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                      Fetch Files
                    </button>
                 </div>
                 {error && (
                    <div className="p-4 text-red-400 text-sm font-mono whitespace-pre-wrap shrink-0 border border-red-500/30 rounded-lg bg-red-500/10 mb-4">{error}</div>
                 )}
                 <div className="flex-1 overflow-y-auto custom-scrollbar border border-white/5 bg-black/40 rounded-lg p-2">
                    {files.length === 0 ? (
                       <div className="h-full flex items-center justify-center text-white/30 text-sm italic">
                          Click "Fetch Files" to list GeoTIFFs from the python server.
                       </div>
                    ) : (
                       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                          {files.map((file, idx) => (
                             <div key={idx} className="flex flex-col border border-white/10 bg-white/5 rounded-lg p-3 hover:bg-white/10 transition-colors">
                                <span className="text-sm text-white/90 truncate mb-2 font-mono group" title={file}>{file}</span>
                                <div className="mt-auto flex justify-end">
                                   <button onClick={() => handleImportFile(file)} className="px-3 py-1 bg-orange-500/20 hover:bg-orange-500 text-orange-400 hover:text-white rounded text-xs transition-colors">
                                     Load to Map
                                   </button>
                                </div>
                             </div>
                          ))}
                       </div>
                    )}
                 </div>
              </div>
            ) : (
              <div className="flex flex-col flex-1 overflow-hidden h-full">
                <label className="block text-xs text-white/50 mb-1 shrink-0">DuckDB SQL Query</label>
                <textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full h-32 min-h-[80px] max-h-[50vh] shrink-0 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-orange-500 resize-y mb-3 custom-scrollbar"
                  placeholder="SELECT * FROM table..."
                />

                <div className="flex justify-end shrink-0 mb-4">
                  <button
                    onClick={handleExecute}
                    disabled={loading}
                    className="flex items-center gap-2 px-6 py-2 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 rounded-lg text-white font-medium transition-all shadow-[0_0_15px_rgba(249,115,22,0.4)] disabled:opacity-50"
                  >
                    {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                    {loading ? 'Executing...' : 'Execute Query'}
                  </button>
                </div>

                {(error || result) && (
                  <div className="flex flex-col flex-1 overflow-hidden min-h-0 border border-white/10 rounded-lg bg-black/40">
                    {error && (
                      <div className="p-4 text-red-400 text-sm font-mono whitespace-pre-wrap overflow-y-auto">{error}</div>
                    )}
                    {result && (
                      <div className="flex flex-col h-full">
                        <div className="px-4 py-2 border-b border-white/10 bg-white/5 shrink-0 flex justify-between items-center">
                          <p className="text-xs text-green-400 font-mono font-bold">Query successful ({result.rows?.length || 0} rows)</p>
                          {result.rows.some((r: any) => result.columns.some((c: string) => typeof r[c] === 'string' && (r[c].startsWith('POLYGON') || r[c].startsWith('MULTIPOLYGON') || r[c].startsWith('POINT') || r[c].startsWith('LINESTRING')))) && (
                            <button
                              onClick={handleAddGeometryToMap}
                              className="flex items-center gap-1.5 px-3 py-1 bg-white/10 hover:bg-white/20 border border-white/20 rounded text-xs text-white transition-colors"
                            >
                              <MapIcon size={14} />
                              Visualize Geometries on Map
                            </button>
                          )}
                        </div>
                        {result.columns && result.columns.length > 0 && result.rows && result.rows.length > 0 ? (
                          <div className="flex-1 overflow-auto custom-scrollbar relative bg-[#0a0a0a]">
                            <table className="min-w-full text-left text-sm text-white/80 border-collapse">
                              <thead className="sticky top-0 bg-[#1a1a1a] shadow-md z-10">
                                <tr>
                                  {standardCols.map((c: string) => (
                                    <th key={c} className="px-4 py-2.5 font-medium border-b border-white/10 whitespace-nowrap">{c}</th>
                                  ))}
                                  {tsCols.length > 0 && (
                                    <th className="px-4 py-2.5 font-medium border-b border-white/10 whitespace-nowrap text-right">Time Series</th>
                                  )}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-white/5">
                                {result.rows.map((r: any, i: number) => (
                                  <React.Fragment key={i}>
                                    <tr className="hover:bg-white/5">
                                      {standardCols.map((c: string) => (
                                        <td key={c} className="px-4 py-2 whitespace-nowrap text-xs font-mono max-w-[300px] overflow-hidden text-ellipsis border-r border-white/5 last:border-r-0">
                                          {r[c] !== null ? String(r[c]) : <span className="text-white/30 italic">NULL</span>}
                                        </td>
                                      ))}
                                    </tr>
                                  </React.Fragment>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="p-4 text-white/50 text-sm italic">No rows returned (or empty result set).</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
};
