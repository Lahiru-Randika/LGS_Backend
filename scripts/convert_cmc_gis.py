#!/usr/bin/env python3
"""
Prepare the selected CMC MASTER FOLDER GIS layers used by LGS.

Input:
    CMC MASTER FOLDER.zip

Output:
    data/gis/cmc/public/*.geojson
    data/gis/cmc/internal/*.geojson
    data/gis/cmc/manifest.json

The source CMC shapefiles use Sri Lanka Grid (EPSG:5235).
This script reprojects them to WGS84 (EPSG:4326), which Leaflet expects.

Install once:
    pip install geopandas pyogrio pyproj shapely

Run from the Express backend project root:
    python scripts/prepare_cmc_gis.py "D:\\path\\CMC MASTER FOLDER.zip"
"""

from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import geopandas as gpd
from shapely import force_2d


CMC_BOUNDS = (
    79.80,  # west
    6.85,   # south
    79.95,  # east
    7.00,   # north
)

SENSITIVE_TOKENS = (
    "owner",
    "owned",
    "tax",
)

RAW_COORDINATE_FIELDS = {
    "northing",
    "easting",
    "longitude",
    "longitute",
    "latitude",
    "latitute",
    "x",
    "y",
    "z",
    "min_x",
    "min_y",
    "min_z",
    "max_x",
    "max_y",
    "max_z",
}

# Each entry specifies enough path information to select the intended
# authoritative source without touching the existing Visigeo building layer.
LAYER_SOURCES = {
    # PUBLIC
    "roadSurface": {
        "access": "public",
        "path_contains": ["feature extraction", "road surface"],
        "stem": "RoadSurface",
    },
    "roadBoundary": {
        "access": "public",
        "path_contains": ["feature extraction", "feature set 2_fine"],
        "stem": "Boundary",
    },
    "roadMarkings": {
        "access": "public",
        "path_contains": ["feature extraction", "feature set 2_fine"],
        "stem": "RoadMarking",
    },
    "laneLines": {
        "access": "public",
        "path_contains": ["feature extraction", "feature set 2_fine"],
        "stem": "LaneLine",
    },
    "stopLines": {
        "access": "public",
        "path_contains": ["feature extraction", "feature set 2_fine"],
        "stem": "Stopline",
    },
    "crosswalks": {
        "access": "public",
        "path_contains": ["feature extraction", "feature set 2_fine"],
        "stem": "Crosswalk",
    },
    "trees": {
        "access": "public",
        "path_contains": ["gnss data shp"],
        "stem": "Trees",
    },
    "busStops": {
        "access": "public",
        "path_contains": ["gnss data shp"],
        "stem": "Bus Stops",
    },
    "signBoards": {
        "access": "public",
        "path_contains": ["gnss data shp"],
        "stem": "Sign Boards",
    },

    # INTERNAL
    "lightPoles": {
        "access": "internal",
        "path_contains": ["gnss data shp"],
        "stem": "Light Poles",
    },
    "manholes": {
        "access": "internal",
        "path_contains": ["gnss data shp"],
        "stem": "Manholes",
    },
    "stormwaterDrains": {
        "access": "internal",
        "path_contains": ["gnss data shp"],
        "stem": "Stormwater Drains",
    },
    "fireHydrants": {
        "access": "internal",
        "path_contains": ["gnss data shp"],
        "stem": "Fire Hydrants",
    },
    "utilityBoxes": {
        "access": "internal",
        "path_contains": ["gnss data shp"],
        "stem": "Utility Boxes",
    },
    "sewage": {
        "access": "internal",
        "path_contains": ["gnss data shp"],
        "stem": "Sewages",
    },
}


def normalized(text: str) -> str:
    return (
        text.replace("\\", "/")
        .strip()
        .lower()
    )


def normalized_field(text: str) -> str:
    return re.sub(
        r"[^a-z0-9]+",
        "_",
        text.strip().lower(),
    ).strip("_")


def find_source(root: Path, config: dict) -> Path:
    wanted_stem = normalized(config["stem"])
    wanted_parts = [
        normalized(part)
        for part in config["path_contains"]
    ]

    matches: list[Path] = []

    for path in root.rglob("*.shp"):
        if "__MACOSX" in path.parts:
            continue

        relative = normalized(
            str(path.relative_to(root))
        )

        if normalized(path.stem) != wanted_stem:
            continue

        if not all(
            part in relative
            for part in wanted_parts
        ):
            continue

        matches.append(path)

    if not matches:
        raise FileNotFoundError(
            f"Could not find source shapefile: {config}"
        )

    if len(matches) > 1:
        raise RuntimeError(
            f"Multiple source shapefiles matched {config}: {matches}"
        )

    return matches[0]


def make_unique_columns(columns: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    output: list[str] = []

    for column in columns:
        if column == "geometry":
            output.append(column)
            continue

        count = seen.get(column, 0)
        seen[column] = count + 1

        output.append(
            column
            if count == 0
            else f"{column}_{count + 1}"
        )

    return output


def keep_property(column: str) -> bool:
    if column == "geometry":
        return False

    key = normalized_field(column)

    if any(
        token in key
        for token in SENSITIVE_TOKENS
    ):
        return False

    if key in RAW_COORDINATE_FIELDS:
        return False

    return True


def convert_layer(
    source: Path,
    target: Path,
) -> dict:
    gdf = gpd.read_file(source)

    if gdf.empty:
        raise RuntimeError(
            f"Source layer is empty: {source}"
        )

    if gdf.crs is None:
        raise RuntimeError(
            f"Source layer has no CRS: {source}"
        )

    source_crs = str(gdf.crs)

    gdf.columns = make_unique_columns(
        list(gdf.columns)
    )

    properties = [
        column
        for column in gdf.columns
        if keep_property(column)
    ]

    gdf = gdf[
        properties + ["geometry"]
    ].copy()

    gdf = gdf[
        gdf.geometry.notna()
    ].copy()

    # EPSG:5235 -> EPSG:4326
    gdf = gdf.to_crs("EPSG:4326")
    gdf.geometry = gdf.geometry.map(force_2d)

    # Remove impossible/outlier coordinates from the supplied CMC set.
    bounds = gdf.geometry.bounds

    valid = (
        (bounds.minx >= CMC_BOUNDS[0])
        & (bounds.maxx <= CMC_BOUNDS[2])
        & (bounds.miny >= CMC_BOUNDS[1])
        & (bounds.maxy <= CMC_BOUNDS[3])
    )

    gdf = gdf.loc[valid].copy()

    if gdf.empty:
        raise RuntimeError(
            f"No valid CMC features remain after bounds validation: {source}"
        )

    payload = json.loads(
        gdf.to_json(
            drop_id=True,
        )
    )

    # RFC7946 GeoJSON assumes WGS84.
    payload.pop("crs", None)

    target.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    target.write_text(
        json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    return {
        "source": str(source),
        "sourceCrs": source_crs,
        "outputCrs": "EPSG:4326",
        "featureCount": int(len(gdf)),
        "properties": properties,
        "geometryTypes": sorted(
            {
                str(value)
                for value in gdf.geometry.geom_type.dropna().unique()
            }
        ),
    }


def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)

    input_path = Path(
        sys.argv[1]
    ).resolve()

    if not input_path.exists():
        raise FileNotFoundError(
            input_path
        )

    backend_root = Path.cwd()

    output_root = (
        backend_root
        / "data"
        / "gis"
        / "cmc"
    )

    temp_root: Path | None = None

    try:
        if input_path.suffix.lower() == ".zip":
            temp_root = Path(
                tempfile.mkdtemp(
                    prefix="lgs-cmc-",
                )
            )

            with zipfile.ZipFile(
                input_path
            ) as archive:
                archive.extractall(
                    temp_root
                )

            source_root = temp_root
        else:
            source_root = input_path

        manifest = {
            "dataset": "CMC MASTER FOLDER",
            "outputCrs": "EPSG:4326",
            "public": [],
            "internal": [],
        }

        for key, config in LAYER_SOURCES.items():
            source = find_source(
                source_root,
                config,
            )

            access = config["access"]

            target = (
                output_root
                / access
                / f"{key}.geojson"
            )

            result = convert_layer(
                source,
                target,
            )

            result["key"] = key
            result["file"] = target.name

            try:
                result["source"] = str(
                    source.relative_to(source_root)
                ).replace("\\", "/")
            except ValueError:
                result["source"] = str(source)

            manifest[access].append(
                result
            )

            print(
                f"OK  {key:<20} "
                f"{result['featureCount']:>4} features "
                f"-> {target}"
            )

        manifest_path = (
            output_root
            / "manifest.json"
        )

        manifest_path.write_text(
            json.dumps(
                manifest,
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        print()
        print("CMC GIS preparation completed.")
        print(f"Manifest: {manifest_path}")

    finally:
        if temp_root:
            shutil.rmtree(
                temp_root,
                ignore_errors=True,
            )


if __name__ == "__main__":
    main()
