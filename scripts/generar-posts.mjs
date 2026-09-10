/**
 * Genera hasta un post por fuente de noticias nueva, como borrador en WordPress.
 * Nunca publica solo: siempre queda en estado draft para revision de Sergio.
 *
 * Uso: node scripts/generar-posts.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSign } from 'node:crypto';
import sharp from 'sharp';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const FUENTES = join(RAIZ, 'data', 'fuentes.json');
const CATEGORIAS = join(RAIZ, 'data', 'categorias.json');
const LOG = join(RAIZ, 'data', 'processed-log.json');

const UA = 'news-pipeline/1.0 (+https://arenin.uk)';
const WP_BASE = 'https://arenin.uk/wp-json/wp/v2';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const WP_APP_USER = process.env.WP_APP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const ADSENSE_INARTICLE_SLOT = process.env.ADSENSE_INARTICLE_SLOT || '';
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const DRIVE_FOLDER_ID = '1jeYD2UzKSLIssXi4_6gMgZT1MTjoozmg';

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

/* --- RSS ---------------------------------------------------------- */

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

function parsearUltimoItemRSS(xml) {
  const bloque = extraerEntre(xml, '<item>', '</item>');
  if (!bloque) return null;
  const titulo = limpiarTexto(extraerEntre(bloque, '<title>', '</title>') || '');
  const link = limpiarTexto(extraerEntre(bloque, '<link>', '</link>') || '');
  const pubDateStr = extraerEntre(bloque, '<pubDate>', '</pubDate>');
  const fecha = pubDateStr ? new Date(pubDateStr) : null;
  if (!titulo || !link || !fecha || Number.isNaN(fecha.getTime())) return null;
  return { titulo, link, fecha };
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

async function generarContenido({ tituloOriginal, textoArticulo, nombresProhibidos, categorias }) {
  const listaCategorias = categorias.map(c => `- ${c.nombre}`).join('\n');
  const listaProhibidos = nombresProhibidos.join(', ');

  const prompt = `Sos un periodista que escribe para ARenIN, un sitio para la comunidad argentina en el Reino Unido.

Te paso el titulo y el texto de una noticia sobre Londres/UK. Tu trabajo es escribir un articulo ORIGINAL en castellano (no una traduccion literal), dirigido a argentinos viviendo en UK, basado en la informacion de esa noticia.

Reglas estrictas:
- Nunca menciones el nombre del medio de donde sale la noticia (${listaProhibidos}).
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

function construirCuerpoHtml({ resumenIntro, secciones }) {
  const seccionesHtml = (secciones || []).map(sec => {
    const parrafosHtml = (sec.parrafos || []).map(p => `<p>${escaparHtml(p)}</p>`).join('\n');
    const listaHtml = (sec.lista && sec.lista.length)
      ? `<ul>\n${sec.lista.map(li => `<li>${escaparHtml(li)}</li>`).join('\n')}\n</ul>`
      : '';
    return `<h3>${escaparHtml(sec.subtitulo)}</h3>\n${parrafosHtml}\n${listaHtml}`;
  }).join('\n');

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
</style>
<div class="qp-answer">
<p>${escaparHtml(resumenIntro)}</p>
</div>
${seccionesHtml}
</div>`;
}

function construirBloqueImagen({ id, url, alt, fotografo }) {
  const figcaption = fotografo
    ? `<figcaption class="wp-element-caption">Foto: ${escaparHtml(fotografo)} / Pexels</figcaption>`
    : '';
  return `<!-- wp:image {"id":${id},"sizeSlug":"large","linkDestination":"none"} -->
<figure class="wp-block-image size-large"><img src="${escaparHtml(url)}" alt="${escaparHtml(alt || '')}" class="wp-image-${id}"/>${figcaption}</figure>
<!-- /wp:image -->`;
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

async function crearBorrador({ titulo, content, resumenIntro, extractoSeo, focusKeyphrase, categoriaId, tagIds, featuredMediaId, imagenUrl }) {
  const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  const imagenIdStr = featuredMediaId ? String(featuredMediaId) : undefined;

  const res = await fetch(`${WP_BASE}/posts`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: titulo,
      content,
      excerpt: resumenIntro,
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

/* --- Imagen para redes sociales (1080x1350) + Google Drive ------------- */

function envolverTexto(texto, maxCaracteresPorLinea) {
  const palabras = texto.split(' ');
  const lineas = [];
  let actual = '';
  for (const palabra of palabras) {
    const prueba = actual ? `${actual} ${palabra}` : palabra;
    if (prueba.length > maxCaracteresPorLinea && actual) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = prueba;
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

async function generarImagenSocial({ imagenUrl, titulo }) {
  const resImg = await fetch(imagenUrl, { headers: { 'User-Agent': UA } });
  if (!resImg.ok) throw new Error(`No se pudo descargar la imagen para redes (HTTP ${resImg.status})`);
  const bufferOriginal = Buffer.from(await resImg.arrayBuffer());

  const ANCHO = 1080;
  const ALTO = 1350;

  const fondo = await sharp(bufferOriginal)
    .resize(ANCHO, ALTO, { fit: 'cover', position: 'centre' })
    .toBuffer();

  const lineas = envolverTexto(titulo, 24).slice(0, 4);
  const lineaAltura = 68;
  const textoAlturaTotal = lineas.length * lineaAltura;
  const textoInicioY = ALTO - 110 - textoAlturaTotal;

  const tspans = lineas
    .map((linea, i) => `<tspan x="64" y="${textoInicioY + i * lineaAltura}">${escaparHtml(linea)}</tspan>`)
    .join('');

  const svg = `<svg width="${ANCHO}" height="${ALTO}" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="degradado" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="#0f172a" stop-opacity="0" />
<stop offset="100%" stop-color="#0f172a" stop-opacity="0.92" />
</linearGradient>
</defs>
<rect x="0" y="${Math.round(ALTO * 0.42)}" width="${ANCHO}" height="${Math.round(ALTO * 0.58)}" fill="url(#degradado)" />
<rect x="64" y="${textoInicioY - 54}" width="84" height="6" fill="#38bdf8" />
<text font-family="Arial, sans-serif" font-weight="bold" font-size="54" fill="#ffffff">${tspans}</text>
</svg>`;

  return sharp(fondo)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function obtenerAccessTokenDrive() {
  const keyJson = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
  const ahora = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: keyJson.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: ahora + 3600,
    iat: ahora
  };
  const entrada = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const firmante = createSign('RSA-SHA256');
  firmante.update(entrada);
  firmante.end();
  const firma = firmante
    .sign(keyJson.private_key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const jwt = `${entrada}.${firma}`;

  const data = await pedirJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  return data.access_token;
}

async function subirImagenADrive({ buffer, nombreArchivo, accessToken }) {
  const boundary = `arenin_${Date.now()}`;
  const metadata = JSON.stringify({ name: nombreArchivo, parents: [DRIVE_FOLDER_ID] });
  const preambulo = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`;
  const cierre = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(preambulo), buffer, Buffer.from(cierre)]);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });
  if (!res.ok) {
    let detalle = '';
    try { detalle = JSON.stringify(await res.json()); } catch { /* nada */ }
    throw new Error(`No se pudo subir la imagen a Drive (HTTP ${res.status})${detalle ? ' - ' + detalle : ''}`);
  }
  return res.json();
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

async function generarYSubirImagenSocial({ imagenUrl, titulo }) {
  if (!GOOGLE_SERVICE_ACCOUNT_KEY) return;
  const buffer = await generarImagenSocial({ imagenUrl, titulo });
  const accessToken = await obtenerAccessTokenDrive();
  await subirImagenADrive({ buffer, nombreArchivo: `${slugify(titulo)}.jpg`, accessToken });
}

/* --- Montaje final ------------------------------------------------------ */

async function procesarFuente(fuente, categorias, log) {
  const xml = await pedirTexto(fuente.rss);
  const item = parsearUltimoItemRSS(xml);
  if (!item) {
    console.log(`  [${fuente.id}] no se pudo leer el feed`);
    return null;
  }

  const ultimaFecha = log[fuente.id] ? new Date(log[fuente.id]) : null;
  if (ultimaFecha && item.fecha <= ultimaFecha) {
    console.log(`  [${fuente.id}] sin novedades (ultimo: ${item.fecha.toISOString()})`);
    return null;
  }

  console.log(`  [${fuente.id}] novedad: "${item.titulo}" (${item.fecha.toISOString()})`);

  const htmlArticulo = await pedirTexto(item.link);
  const textoArticulo = extraerTextoVisible(htmlArticulo);

  const generado = await generarContenido({
    tituloOriginal: item.titulo,
    textoArticulo,
    nombresProhibidos: fuente.nombresProhibidos,
    categorias
  });

  let featuredMediaId = null;
  let imagenCuerpo = null;
  try {
    const imagen = await buscarImagen(generado.imagenQuery || generado.titulo);
    if (imagen) {
      const subida = await subirImagenAWordPress(imagen.url, `${fuente.id}-${Date.now()}.jpg`, generado.titulo);
      featuredMediaId = subida.id;
      imagenCuerpo = { url: subida.url, fotografo: imagen.fotografo, alt: generado.titulo };
    }
  } catch (err) {
    console.error(`  [${fuente.id}] no se pudo conseguir/subir imagen: ${err.message}`);
  }

  if (imagenCuerpo) {
    try {
      await generarYSubirImagenSocial({ imagenUrl: imagenCuerpo.url, titulo: generado.titulo });
      console.log(`  [${fuente.id}] imagen para redes sociales subida a Drive`);
    } catch (err) {
      console.error(`  [${fuente.id}] no se pudo generar/subir la imagen para redes: ${err.message}`);
    }
  }

  if (generado.categoriaEsNueva) {
    console.log(`  [${fuente.id}] SUGERENCIA: nueva categoria "${generado.categoria}" (revisar y crear manualmente si corresponde)`);
  }
  const categoria = elegirCategoria(generado.categoria, categorias);

  let tagIds = [];
  try {
    tagIds = await resolverTags(generado.tags || []);
  } catch (err) {
    console.error(`  [${fuente.id}] no se pudieron resolver los tags: ${err.message}`);
  }

  const bloqueImagen = imagenCuerpo
    ? construirBloqueImagen({ id: featuredMediaId, url: imagenCuerpo.url, alt: generado.titulo, fotografo: imagenCuerpo.fotografo })
    : '';
  const content = [
    `<!-- wp:html -->\n${ADSENSE_BANNER}\n<!-- /wp:html -->`,
    bloqueImagen,
    `<!-- wp:html -->\n${construirCuerpoHtml(generado)}\n${adsenseInArticle()}\n<!-- /wp:html -->`
  ].filter(Boolean).join('\n\n');

  const post = await crearBorrador({
    titulo: generado.titulo,
    content,
    resumenIntro: generado.resumenIntro,
    extractoSeo: generado.extractoSeo,
    focusKeyphrase: generado.focusKeyphrase,
    categoriaId: categoria.id,
    tagIds,
    featuredMediaId,
    imagenUrl: imagenCuerpo ? imagenCuerpo.url : null
  });

  console.log(`  [${fuente.id}] borrador creado: post #${post.id} (categoria: ${categoria.nombre})`);
  log[fuente.id] = item.fecha.toISOString();
  return post.id;
}

async function main() {
  const faltantes = ['GEMINI_API_KEY', 'PEXELS_API_KEY', 'WP_APP_USER', 'WP_APP_PASSWORD']
    .filter(v => !process.env[v]);
  if (faltantes.length) {
    console.error(`Faltan variables de entorno: ${faltantes.join(', ')}. No se procesa nada.`);
    process.exit(1);
  }

  const fuentes = JSON.parse(await readFile(FUENTES, 'utf8'));
  const categorias = JSON.parse(await readFile(CATEGORIAS, 'utf8'));
  const log = JSON.parse(await readFile(LOG, 'utf8'));

  let creados = 0;
  const errores = [];

  for (const fuente of fuentes) {
    console.log(`Revisando ${fuente.id}...`);
    try {
      const postId = await procesarFuente(fuente, categorias, log);
      if (postId) creados++;
    } catch (err) {
      console.error(`  [${fuente.id}] error: ${err.message}`);
      errores.push(fuente.id);
    }
  }

  await writeFile(LOG, JSON.stringify(log, null, 2) + '\n', 'utf8');
  console.log(`Listo. ${creados} borrador(es) creado(s). ${errores.length ? `Con errores en: ${errores.join(', ')}` : ''}`);
}

main().catch(err => { console.error(err); process.exit(1); });
