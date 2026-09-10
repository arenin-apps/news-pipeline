/**
 * Genera un post en WordPress (como borrador) a partir de una URL que Sergio comparte.
 * Nunca publica solo: siempre queda en estado draft para revision de Sergio.
 *
 * Uso: POST_URL=https://... node scripts/generar-post-manual.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATEGORIAS = join(RAIZ, 'data', 'categorias.json');

const UA = 'news-pipeline/1.0 (+https://arenin.uk)';
const WP_BASE = 'https://arenin.uk/wp-json/wp/v2';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const WP_APP_USER = process.env.WP_APP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const ADSENSE_INARTICLE_SLOT = process.env.ADSENSE_INARTICLE_SLOT || '';
const POST_URL = process.env.POST_URL;

const ADSENSE_BANNER = `<div style="text-align:center;">
<p style="color:#94a3b8; font-size:11px; letter-spacing:1px; text-transform:uppercase; margin:0 0 6px 0;">Publicidad</p>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8667684098323123" crossorigin="anonymous"></script>
<ins class="adsbygoogle" style="display:inline-block;width:320px;height:50px" data-ad-client="ca-pub-8667684098323123" data-ad-slot="6078156861"></ins>
<script>
(adsbygoogle = window.adsbygoogle || []).push({});
</script>
</div>`;

function adsenseInArticle() {
  if (!ADSENSE_INARTICLE_SLOT) return '';
  return `<div style="text-align:center; margin: 24px 0;">
<p style="color:#94a3b8; font-size:11px; letter-spacing:1px; text-transform:uppercase; margin:0 0 6px 0;">Publicidad</p>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8667684098323123" crossorigin="anonymous"></script>
<ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-8667684098323123" data-ad-slot="${ADSENSE_INARTICLE_SLOT}" data-ad-format="fluid" data-ad-layout="in-article"></ins>
<script>
(adsbygoogle = window.adsbygoogle || []).push({});
</script>
</div>`;
}

/* ------------------------------------------------------------------ */

async function pedirTexto(url, intentos = 3) {
  let ultimoError;
  for (let n = 1; n <= intentos; n++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      ultimoError = err;
      if (n < intentos) await new Promise(r => setTimeout(r, 3000 * n));
    }
  }
  throw ultimoError;
}

async function pedirJson(url, opciones = {}, intentos = 3) {
  let ultimoError;
  for (let n = 1; n <= intentos; n++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 90000);
      const res = await fetch(url, { ...opciones, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        let detalle = '';
        try { detalle = JSON.stringify(await res.json()); } catch { /* cuerpo no era JSON */ }
        throw new Error(`HTTP ${res.status}${detalle ? ' - ' + detalle : ''}`);
      }
      return await res.json();
    } catch (err) {
      ultimoError = err;
      if (n < intentos) await new Promise(r => setTimeout(r, 3000 * n));
    }
  }
  throw ultimoError;
}

/* --- Extraccion de la pagina ---------------------------------------- */

function extraerEntre(texto, inicio, fin, desde = 0) {
  const i = texto.indexOf(inicio, desde);
  if (i === -1) return null;
  const j = texto.indexOf(fin, i + inicio.length);
  if (j === -1) return null;
  return texto.slice(i + inicio.length, j);
}

function limpiarTexto(s) {
  return s
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function extraerTitulo(html) {
  const ogTitle = extraerEntre(html, 'property="og:title" content="', '"');
  if (ogTitle) return limpiarTexto(ogTitle);
  const tag = extraerEntre(html, '<title>', '</title>');
  return tag ? limpiarTexto(tag) : '';
}

function extraerTextoVisible(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

/* --- Gemini --------------------------------------------------------- */

async function generarContenido({ tituloOriginal, textoArticulo, dominioOrigen, categorias }) {
  const listaCategorias = categorias.map(c => `- ${c.nombre}`).join('\n');

  const prompt = `Sos un periodista que escribe para ARenIN, un sitio para la comunidad argentina en el Reino Unido.

Sergio (el editor del sitio) encontro una noticia interesante para la comunidad y te pasa el titulo y el texto. Tu trabajo es escribir un articulo ORIGINAL en castellano (no una traduccion literal), dirigido a argentinos viviendo en UK, basado en la informacion de esa noticia.

Reglas estrictas:
- Nunca menciones el nombre del sitio o medio de donde sale esta noticia (dominio: ${dominioOrigen}).
- Si la noticia original cita una fuente primaria (gov.uk, Met Office, TfL, NHS, la Policia, un ministerio, etc.), podes citarla vos tambien.
- El contenido se arma en dos partes: un resumen directo (resumenIntro) y de 2 a 4 secciones con subtitulo.
- resumenIntro: 2 a 3 frases que respondan de entrada lo mas importante de la noticia, sin rodeos.
- Cada seccion tiene un subtitulo corto, 1 o 2 parrafos, y opcionalmente una lista de puntos si el contenido se presta (fechas, pasos, datos sueltos). Si no hace falta lista, dejala como array vacio.
- No repitas en las secciones lo mismo que ya dice el resumenIntro.
- Extension total: 250 a 450 palabras.
- Elegi la categoria mas apropiada de esta lista (o sugeri una nueva si ninguna encaja bien):
${listaCategorias}
- Sugeri de 2 a 4 tags cortos (1 a 3 palabras cada uno) en castellano, relevantes para el tema (ej. lugares, instituciones, temas puntuales).

Titulo original (de referencia, no lo copies literal): ${tituloOriginal}

Texto de referencia:
${textoArticulo}

Responde UNICAMENTE con un JSON con esta forma exacta, sin texto antes ni despues, sin bloque de codigo markdown, sin etiquetas HTML dentro de los textos:
{
  "titulo": "titulo nuevo en castellano, atractivo, sin comillas",
  "resumenIntro": "2 a 3 frases con la respuesta directa, sin HTML",
  "secciones": [
    { "subtitulo": "...", "parrafos": ["parrafo 1", "parrafo 2 opcional"], "lista": ["punto 1", "punto 2"] }
  ],
  "extractoSeo": "resumen de 130-155 caracteres para meta description",
  "focusKeyphrase": "frase clave de 2 a 4 palabras para SEO",
  "categoria": "nombre exacto de una categoria de la lista, o una nueva sugerida",
  "categoriaEsNueva": false,
  "tags": ["tag uno", "tag dos", "tag tres"],
  "imagenQuery": "2 a 4 palabras en ingles para buscar una foto relacionada en un banco de imagenes"
}`;

  const data = await pedirJson(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, responseMimeType: 'application/json' }
      })
    }
  );

  const texto = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error('Gemini no devolvio contenido');
  return JSON.parse(texto);
}

/* --- Formato visual del cuerpo ("quick post") ------------------------ */

function escaparHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function construirCuerpoHtml({ resumenIntro, secciones, imagen }) {
  const seccionesHtml = (secciones || []).map(sec => {
    const parrafosHtml = (sec.parrafos || []).map(p => `<p>${escaparHtml(p)}</p>`).join('\n');
    const listaHtml = (sec.lista && sec.lista.length)
      ? `<ul>\n${sec.lista.map(li => `<li>${escaparHtml(li)}</li>`).join('\n')}\n</ul>`
      : '';
    return `<h3>${escaparHtml(sec.subtitulo)}</h3>\n${parrafosHtml}\n${listaHtml}`;
  }).join('\n');

  const imagenHtml = imagen ? `<figure class="qp-imagen">
<img src="${escaparHtml(imagen.url)}" alt="${escaparHtml(imagen.alt || '')}" loading="lazy" />
${imagen.fotografo ? `<figcaption>Foto: ${escaparHtml(imagen.fotografo)} / Pexels</figcaption>` : ''}
</figure>` : '';

  return `<div class="arenin-quick-post">
<style>
.arenin-quick-post {
    --primary: #38bdf8; --card-bg: #0f172a; --text-primary: #f1f5f9;
    --text-secondary: #94a3b8; --border-color: #1e293b; --radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--text-primary); line-height: 1.75; max-width: 720px; margin: 0 auto;
}
.arenin-quick-post h3 { font-size: 1.05rem; color: var(--primary); margin: 1.3rem 0 0.4rem; }
.arenin-quick-post .qp-answer {
    background: var(--card-bg); border: 1px solid var(--primary); border-left: 4px solid var(--primary);
    border-radius: var(--radius); padding: 1.3rem 1.5rem; margin-bottom: 1.8rem;
}
.arenin-quick-post .qp-answer p { margin: 0; font-size: 1.05rem; }
.arenin-quick-post p { color: var(--text-secondary); margin-bottom: 1.1rem; }
.arenin-quick-post strong { color: var(--text-primary); }
.arenin-quick-post ol, .arenin-quick-post ul { padding-left: 1.4rem; margin-bottom: 1.2rem; }
.arenin-quick-post li { color: var(--text-secondary); margin-bottom: 0.6rem; }
.arenin-quick-post .qp-imagen { margin: 0 0 1.5rem; }
.arenin-quick-post .qp-imagen img { width: 100%; height: auto; border-radius: var(--radius); display: block; }
.arenin-quick-post .qp-imagen figcaption { font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.4rem; text-align: right; }
</style>
${imagenHtml}
<div class="qp-answer">
<p>${escaparHtml(resumenIntro)}</p>
</div>
${seccionesHtml}
</div>`;
}

/* --- Pexels ---------------------------------------------------------- */

async function buscarImagen(query) {
  const data = await pedirJson(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
    { headers: { Authorization: PEXELS_API_KEY } }
  );
  const foto = data.photos?.[0];
  if (!foto) return null;
  return { url: foto.src.large, fotografo: foto.photographer };
}

async function subirImagenAWordPress(urlImagen, nombreArchivo, altText) {
  const resImg = await fetch(urlImagen, { headers: { 'User-Agent': UA } });
  if (!resImg.ok) throw new Error(`No se pudo descargar la imagen (HTTP ${resImg.status})`);
  const buffer = Buffer.from(await resImg.arrayBuffer());

  const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  const res = await fetch(`${WP_BASE}/media`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'image/jpeg',
      'Content-Disposition': `attachment; filename="${nombreArchivo}"`
    },
    body: buffer
  });
  if (!res.ok) throw new Error(`No se pudo subir la imagen a WordPress (HTTP ${res.status})`);
  const media = await res.json();

  await fetch(`${WP_BASE}/media/${media.id}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ alt_text: altText })
  });

  return { id: media.id, url: media.source_url };
}

/* --- WordPress -------------------------------------------------------- */

function elegirCategoria(nombreSugerido, categorias) {
  const normalizado = nombreSugerido.trim().toLowerCase();
  const encontrada = categorias.find(c => c.nombre.toLowerCase() === normalizado);
  return encontrada || categorias.find(c => c.slug === 'news');
}

async function resolverTags(nombres) {
  const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  const ids = [];
  for (const nombre of nombres) {
    const limpio = nombre.trim();
    if (!limpio) continue;
    const encontrados = await pedirJson(`${WP_BASE}/tags?search=${encodeURIComponent(limpio)}`, {
      headers: { Authorization: `Basic ${auth}` }
    });
    const existente = encontrados.find(t => t.name.toLowerCase() === limpio.toLowerCase());
    if (existente) {
      ids.push(existente.id);
      continue;
    }
    const creado = await pedirJson(`${WP_BASE}/tags`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: limpio })
    });
    ids.push(creado.id);
  }
  return ids;
}

async function crearBorrador({ titulo, cuerpoHtml, extractoSeo, focusKeyphrase, categoriaId, tagIds, featuredMediaId, imagenUrl }) {
  const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  const contenidoConAds = `${ADSENSE_BANNER}\n${cuerpoHtml}\n${adsenseInArticle()}`;
  const imagenIdStr = featuredMediaId ? String(featuredMediaId) : undefined;

  const res = await fetch(`${WP_BASE}/posts`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: titulo,
      content: contenidoConAds,
      status: 'draft',
      categories: [categoriaId],
      tags: tagIds || [],
      featured_media: featuredMediaId || undefined,
      meta: {
        _yoast_wpseo_title: `${titulo} | ARenIN`,
        _yoast_wpseo_metadesc: extractoSeo,
        _yoast_wpseo_focuskw: focusKeyphrase,
        '_yoast_wpseo_opengraph-title': titulo,
        '_yoast_wpseo_opengraph-description': extractoSeo,
        '_yoast_wpseo_opengraph-image': imagenUrl || undefined,
        '_yoast_wpseo_opengraph-image-id': imagenIdStr,
        '_yoast_wpseo_twitter-title': titulo,
        '_yoast_wpseo_twitter-description': extractoSeo,
        '_yoast_wpseo_twitter-image': imagenUrl || undefined,
        '_yoast_wpseo_twitter-image-id': imagenIdStr
      }
    })
  });
  if (!res.ok) {
    let detalle = '';
    try { detalle = JSON.stringify(await res.json()); } catch { /* nada */ }
    throw new Error(`No se pudo crear el borrador (HTTP ${res.status})${detalle ? ' - ' + detalle : ''}`);
  }
  return res.json();
}

/* --- Montaje final ------------------------------------------------------ */

async function main() {
  const faltantes = ['GEMINI_API_KEY', 'PEXELS_API_KEY', 'WP_APP_USER', 'WP_APP_PASSWORD']
    .filter(v => !process.env[v]);
  if (faltantes.length) {
    console.error(`Faltan variables de entorno: ${faltantes.join(', ')}. No se procesa nada.`);
    process.exit(1);
  }

  if (!POST_URL) {
    console.error('Falta la variable POST_URL con la URL del articulo a convertir en post.');
    process.exit(1);
  }

  let urlValida;
  try {
    urlValida = new URL(POST_URL);
  } catch {
    console.error(`POST_URL no es una URL valida: ${POST_URL}`);
    process.exit(1);
  }

  const categorias = JSON.parse(await readFile(CATEGORIAS, 'utf8'));
  const dominioOrigen = urlValida.hostname.replace(/^www\./, '');

  console.log(`Leyendo ${POST_URL}...`);
  const html = await pedirTexto(POST_URL);
  const tituloOriginal = extraerTitulo(html) || POST_URL;
  const textoArticulo = extraerTextoVisible(html);
  console.log(`Titulo original detectado: "${tituloOriginal}"`);

  const generado = await generarContenido({ tituloOriginal, textoArticulo, dominioOrigen, categorias });

  let featuredMediaId = null;
  let imagenCuerpo = null;
  try {
    const imagen = await buscarImagen(generado.imagenQuery || generado.titulo);
    if (imagen) {
      const subida = await subirImagenAWordPress(imagen.url, `manual-${Date.now()}.jpg`, generado.titulo);
      featuredMediaId = subida.id;
      imagenCuerpo = { url: subida.url, fotografo: imagen.fotografo, alt: generado.titulo };
    }
  } catch (err) {
    console.error(`No se pudo conseguir/subir imagen: ${err.message}`);
  }

  if (generado.categoriaEsNueva) {
    console.log(`SUGERENCIA: nueva categoria "${generado.categoria}" (revisar y crear manualmente si corresponde)`);
  }
  const categoria = elegirCategoria(generado.categoria, categorias);

  let tagIds = [];
  try {
    tagIds = await resolverTags(generado.tags || []);
  } catch (err) {
    console.error(`No se pudieron resolver los tags: ${err.message}`);
  }

  const post = await crearBorrador({
    titulo: generado.titulo,
    cuerpoHtml: construirCuerpoHtml({ ...generado, imagen: imagenCuerpo }),
    extractoSeo: generado.extractoSeo,
    focusKeyphrase: generado.focusKeyphrase,
    categoriaId: categoria.id,
    tagIds,
    featuredMediaId,
    imagenUrl: imagenCuerpo ? imagenCuerpo.url : null
  });

  console.log(`Listo. Borrador creado: post #${post.id} "${generado.titulo}" (categoria: ${categoria.nombre}). Revisalo en WordPress antes de publicar.`);
}

main().catch(err => { console.error(err); process.exit(1); });
