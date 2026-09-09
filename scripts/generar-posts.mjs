/**
 * Genera hasta un post por fuente de noticias nueva, como borrador en WordPress.
 * Nunca publica solo: siempre queda en estado draft para revision de Sergio.
 *
 * Uso: node scripts/generar-posts.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  - El cuerpo va en HTML compatible con el editor Gutenberg de WordPress: usa etiquetas <p>, <h2>, <ul>/<li> donde corresponda. No uses <html>, <head> ni <body>.
  - Extension: 250 a 450 palabras.
  - Elegi la categoria mas apropiada de esta lista (o sugeri una nueva si ninguna encaja bien):
  ${listaCategorias}

  Titulo original (de referencia, no lo copies literal): ${tituloOriginal}

  Texto de referencia:
  ${textoArticulo}

  Responde UNICAMENTE con un JSON con esta forma exacta, sin texto antes ni despues, sin bloque de codigo markdown:
  {
    "titulo": "titulo nuevo en castellano, atractivo, sin comillas",
      "cuerpoHtml": "cuerpo del post en HTML",
        "extractoSeo": "resumen de 130-155 caracteres para meta description",
          "focusKeyphrase": "frase clave de 2 a 4 palabras para SEO",
            "categoria": "nombre exacto de una categoria de la lista, o una nueva sugerida",
              "categoriaEsNueva": false,
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

  return media.id;
}

/* --- WordPress -------------------------------------------------------- */

function elegirCategoria(nombreSugerido, categorias) {
    const normalizado = nombreSugerido.trim().toLowerCase();
    const encontrada = categorias.find(c => c.nombre.toLowerCase() === normalizado);
    return encontrada || categorias.find(c => c.slug === 'news');
}

async function crearBorrador({ titulo, cuerpoHtml, extractoSeo, focusKeyphrase, categoriaId, featuredMediaId }) {
    const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  const contenidoConAds = `${ADSENSE_BANNER}\n${cuerpoHtml}\n${adsenseInArticle()}`;

  const res = await fetch(`${WP_BASE}/posts`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
                title: titulo,
                content: contenidoConAds,
                status: 'draft',
                categories: [categoriaId],
                featured_media: featuredMediaId || undefined,
                meta: {
                          _yoast_wpseo_title: `${titulo} | ARenIN`,
                          _yoast_wpseo_metadesc: extractoSeo,
                          _yoast_wpseo_focuskw: focusKeyphrase
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
    try {
          const imagen = await buscarImagen(generado.imagenQuery || generado.titulo);
          if (imagen) {
                  featuredMediaId = await subirImagenAWordPress(imagen.url, `${fuente.id}-${Date.now()}.jpg`, generado.titulo);
          }
    } catch (err) {
          console.error(`  [${fuente.id}] no se pudo conseguir/subir imagen: ${err.message}`);
    }

  if (generado.categoriaEsNueva) {
        console.log(`  [${fuente.id}] SUGERENCIA: nueva categoria "${generado.categoria}" (revisar y crear manualmente si corresponde)`);
  }
    const categoria = elegirCategoria(generado.categoria, categorias);

  const post = await crearBorrador({
        titulo: generado.titulo,
        cuerpoHtml: generado.cuerpoHtml,
        extractoSeo: generado.extractoSeo,
        focusKeyphrase: generado.focusKeyphrase,
        categoriaId: categoria.id,
        featuredMediaId
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
