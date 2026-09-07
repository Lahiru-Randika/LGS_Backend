const url =
  'http://localhost:5173/cmc/vector/buildings.geojson'

const response =
  await fetch(url)

if (!response.ok) {
  throw new Error(
    `HTTP ${response.status}`,
  )
}

const data =
  await response.json()

function valueFrom(
  properties,
  keys,
) {
  for (const key of keys) {
    const value =
      properties?.[key]

    if (
      value !== undefined &&
      value !== null &&
      String(value).trim()
    ) {
      return String(value).trim()
    }
  }

  return null
}

function rawFeatureId(
  feature,
) {
  const properties =
    feature.properties ||
    {}

  return (
    valueFrom(
      properties,
      [
        'id',
        'ID',
        'Id',
        'fid',
        'FID',
        'OBJECTID',
        'ObjectID',
        'objectid',
        'building_id',
        'buildingid',
      ],
    ) ??
    (
      feature.id !==
      undefined
        ? String(
            feature.id,
          )
        : null
    )
  )
}

const counts =
  new Map()

data.features.forEach(
  (
    feature,
    index,
  ) => {
    const id =
      rawFeatureId(
        feature,
      ) ??
      `NO-ID-${index}`

    counts.set(
      id,
      (
        counts.get(
          id,
        ) ||
        0
      ) +
      1,
    )
  },
)

const duplicates =
  [...counts.entries()]
    .filter(
      ([, count]) =>
        count > 1,
    )
    .sort(
      (
        a,
        b,
      ) =>
        b[1] -
        a[1],
    )

console.log(
  '\nTotal GeoJSON features:',
  data.features.length,
)

console.log(
  'Unique raw IDs:',
  counts.size,
)

console.log(
  'Duplicate IDs:',
  duplicates.length,
)

console.log(
  '\nDuplicates:\n',
)

console.table(
  duplicates.map(
    (
      [
        id,
        count,
      ],
    ) => ({
      id,
      count,
    }),
  ),
)