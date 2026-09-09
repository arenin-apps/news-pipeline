# news-pipeline

Genera borradores de posts diarios en castellano para [arenin.uk](https://arenin.uk), a partir de noticias recientes de sitios sobre Londres/UK. Nunca publica solo: todo queda como `draft` para que Sergio revise y apruebe manualmente.

## Como funciona

1. **Deteccion de novedades**: lee el RSS de cada fuente (`data/fuentes.json`) y compara la fecha del ultimo item contra `data/processed-log.json`. Si no hay novedad, no hace nada.
2. **Generacion**: manda el titulo + texto del articulo original a Gemini, que devuelve un articulo nuevo en castellano (nunca menciona el medio de origen, pero si puede citar fuentes primarias como gov.uk, Met Office, TfL, NHS).
3. **Imagen**: busca una foto libre de derechos en Pexels y la sube a la libreria de medios de WordPress.
4. **SEO**: completa titulo SEO, meta description y focus keyphrase de Yoast via REST.
5. **Categoria**: Gemini elige la mas apropiada de `data/categorias.json`; si sugiere una nueva, queda anotado en el log de la corrida para que Sergio la cree a mano si le parece bien.
6. **Publicidad**: inserta el banner de AdSense ya usado en el resto del sitio, y opcionalmente una segunda unidad in-article si esta configurado `ADSENSE_INARTICLE_SLOT`.
7. **Publicacion**: crea el post en WordPress como `draft` via REST, usando un Application Password.

## Variables de entorno / secrets

- `GEMINI_API_KEY`
- `PEXELS_API_KEY`
- `WP_APP_USER`
- `WP_APP_PASSWORD`
- `ADSENSE_INARTICLE_SLOT` (opcional)

## Uso manual

```
GEMINI_API_KEY=... PEXELS_API_KEY=... WP_APP_USER=... WP_APP_PASSWORD=... node scripts/generar-posts.mjs
```

En GitHub Actions corre solo, una vez por dia (`.github/workflows/generar-posts.yml`), o a demanda desde la pestana Actions ("Run workflow").
