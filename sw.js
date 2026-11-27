/* Service worker del Registro certificado de llamadas (DISENO.md, apartado 4.11).
 *
 * - Caché de la aplicación versionada con version.json: cada versión publicada tiene su propia
 *   caché («registro-llamadas-app-<id>»), donde <id> se calcula con la huella SHA-256 del
 *   contenido de version.json. La página usa siempre la versión activa; cuando se publica otra,
 *   se descarga en segundo plano y se avisa a la página, que la activa cuando el usuario lo pide
 *   (nunca en mitad de una grabación).
 * - Modo sin conexión: la página y sus archivos se sirven desde la caché; lo que no está en ella
 *   se pide a la red y se guarda (por ejemplo, los .wasm de onnxruntime la primera vez que se
 *   transcribe).
 * - Cabeceras Cross-Origin-Opener-Policy: same-origin y Cross-Origin-Embedder-Policy:
 *   require-corp en todas las respuestas propias, para que la página quede aislada y
 *   onnxruntime pueda usar SharedArrayBuffer (hilos). GitHub Pages no permite configurarlas.
 * - Las peticiones a otros orígenes (rfc3161.ai.moda, huggingface.co y sus servidores de
 *   descarga) no se tocan: van directas a la red con CORS. Con COEP require-corp, la página
 *   solo puede hacer a otros orígenes peticiones CORS (fetch por defecto), que estos admiten.
 *
 * Todas las rutas son relativas al ámbito del service worker (el sitio vive en una subruta).
 */

// scripts/construir.mjs sustituye el marcador por la versión y la huella del sitio: así cada
// publicación cambia este archivo y el navegador detecta el service worker nuevo.
const VERSION_SITIO = "1.0.0+f2c8d436384cf91b";
const PREFIJO = "registro-llamadas-app-";
const META = "registro-llamadas-meta";
const CLAVE_ACTIVA = "meta/version-activa";
const CLAVE_INSTALADA = "meta/version-instalada";
const CLAVE_DISPONIBLE = "meta/version-disponible";

// Archivos que se guardan al instalar si version.json no trae su propia lista («archivos»).
const BASICOS = [
  "./",
  "index.html",
  "app.js",
  "app.css",
  "trabajador.js",
  "manifest.webmanifest",
  "version.json",
  "iconos/apple-touch-icon.png",
  "iconos/icono-180.png",
  "iconos/icono-192.png",
  "iconos/icono-512.png",
  "fuentes/LiberationSans-Regular.ttf",
  "fuentes/LiberationSans-Bold.ttf",
  "fuentes/LiberationSans-Italic.ttf",
  "fuentes/LiberationMono-Regular.ttf",
];

const CABECERAS_AISLAMIENTO = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

let activaEnMemoria = null;

const urlDe = (relativa) => new URL(relativa, self.registration.scope).href;
const nombreCache = (id) => `${PREFIJO}${id}`;

// ------------------------------------------------------------------ metadatos

async function leerMeta(clave) {
  const c = await caches.open(META);
  const r = await c.match(urlDe(clave));
  return r ? (await r.text()) || null : null;
}

async function escribirMeta(clave, valor) {
  const c = await caches.open(META);
  if (valor === null || valor === undefined) await c.delete(urlDe(clave));
  else await c.put(urlDe(clave), new Response(String(valor), { headers: { "Content-Type": "text/plain" } }));
}

async function versionActiva() {
  if (activaEnMemoria) return activaEnMemoria;
  activaEnMemoria = await leerMeta(CLAVE_ACTIVA);
  return activaEnMemoria;
}

// ------------------------------------------------------------------ versión publicada

async function huellaTexto(texto) {
  const datos = new TextEncoder().encode(texto);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", datos));
  return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lee version.json de la red: {id, version, archivos}. Lanza si no se puede leer. */
async function versionRemota() {
  const r = await fetch(urlDe("version.json"), { cache: "no-store", credentials: "same-origin" });
  if (!r.ok) throw new Error(`version.json: ${r.status}`);
  const texto = await r.text();
  let datos = {};
  try {
    datos = JSON.parse(texto);
  } catch {
    datos = {};
  }
  return {
    id: await huellaTexto(texto),
    version: String(datos.version || ""),
    archivos: Array.isArray(datos.archivos) ? datos.archivos.filter((x) => typeof x === "string") : null,
    texto,
  };
}

/** Descarga los archivos de la versión en su caché. Un archivo que falta no impide el resto. */
async function precargar(info) {
  const cache = await caches.open(nombreCache(info.id));
  const lista = new Set(["./", "index.html", ...(info.archivos || BASICOS)]);
  await Promise.all(
    [...lista].map(async (rel) => {
      const url = urlDe(rel);
      if (new URL(url).origin !== self.location.origin) return;
      if (rel === "version.json" && info.texto) {
        await cache.put(url, new Response(info.texto, { headers: { "Content-Type": "application/json" } }));
        return;
      }
      try {
        const r = await fetch(url, { cache: "no-cache", credentials: "same-origin" });
        if (r.ok && r.status === 200) await cache.put(url, r);
      } catch {
        // sin conexión o archivo inexistente: se pedirá a la red cuando haga falta
      }
    }),
  );
}

async function borrarAntiguas(conservar) {
  const nombres = await caches.keys();
  await Promise.all(nombres.filter((n) => n.startsWith(PREFIJO) && !conservar.includes(n)).map((n) => caches.delete(n)));
}

async function activarVersion(id) {
  await escribirMeta(CLAVE_ACTIVA, id);
  await escribirMeta(CLAVE_DISPONIBLE, null);
  activaEnMemoria = id;
  await borrarAntiguas([nombreCache(id)]);
}

async function avisarClientes(mensaje) {
  const clientes = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of clientes) c.postMessage(mensaje);
}

// ------------------------------------------------------------------ ciclo de vida

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    (async () => {
      let info;
      try {
        info = await versionRemota();
      } catch {
        info = { id: "local", version: "", archivos: null, texto: null };
      }
      await precargar(info);
      await escribirMeta(CLAVE_INSTALADA, info.id);
      // La primera instalación se activa enseguida; una actualización del propio service worker
      // espera a que la página lo pida.
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    (async () => {
      const instalada = await leerMeta(CLAVE_INSTALADA);
      if (instalada) await activarVersion(instalada);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (evento) => {
  const m = evento.data || {};
  if (m.tipo === "comprobar") evento.waitUntil(comprobar(evento.source));
  else if (m.tipo === "activar") evento.waitUntil(activarPendiente(Boolean(m.espera)));
});

async function comprobar(origen) {
  let info;
  try {
    info = await versionRemota();
  } catch {
    return; // sin conexión
  }
  const activa = await versionActiva();
  if (!activa) {
    // Sin versión activa anotada (metadatos perdidos): se guarda y se activa la publicada.
    await precargar(info);
    await activarVersion(info.id).catch(() => {});
    origen?.postMessage?.({ tipo: "al-dia" });
    return;
  }
  if (info.id === activa) {
    origen?.postMessage?.({ tipo: "al-dia" });
    return;
  }
  const disponible = await leerMeta(CLAVE_DISPONIBLE);
  if (disponible !== info.id) {
    await precargar(info);
    await escribirMeta(CLAVE_DISPONIBLE, info.id);
  }
  await avisarClientes({ tipo: "nueva-version", version: info.version });
}

async function activarPendiente(espera) {
  if (espera) {
    // Mensaje dirigido al service worker nuevo en espera: al activarse, la página recarga.
    await self.skipWaiting();
    return;
  }
  const disponible = await leerMeta(CLAVE_DISPONIBLE);
  const activa = await versionActiva();
  if (disponible && disponible !== activa) await activarVersion(disponible);
  await avisarClientes({ tipo: "activada" });
}

// ------------------------------------------------------------------ peticiones

function conCabeceras(respuesta, url) {
  if (!respuesta || respuesta.type === "opaque" || respuesta.type === "opaqueredirect" || respuesta.status === 0) return respuesta;
  const cabeceras = new Headers(respuesta.headers);
  for (const [k, v] of Object.entries(CABECERAS_AISLAMIENTO)) cabeceras.set(k, v);
  // WebAssembly.instantiateStreaming exige application/wasm; algunos servidores no lo ponen.
  const ruta = url ? url.pathname : "";
  if (/\.wasm$/i.test(ruta) && !/application\/wasm/i.test(cabeceras.get("Content-Type") || "")) cabeceras.set("Content-Type", "application/wasm");
  else if (/\.mjs$/i.test(ruta) && !/javascript/i.test(cabeceras.get("Content-Type") || "")) cabeceras.set("Content-Type", "text/javascript");
  const sinCuerpo = [101, 204, 205, 304].includes(respuesta.status);
  return new Response(sinCuerpo ? null : respuesta.body, { status: respuesta.status, statusText: respuesta.statusText, headers: cabeceras });
}

function paginaSinConexion() {
  const html =
    '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Sin conexión</title><body style="font-family:-apple-system,sans-serif;padding:32px 20px;line-height:1.5">' +
    "<h1>Sin conexión</h1><p>La aplicación todavía no se ha guardado en este iPhone para usarla sin conexión. " +
    "Ábrala una vez con conexión a internet.</p></body></html>";
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function desdeCache(clave) {
  const id = await versionActiva();
  if (id) {
    const c = await caches.open(nombreCache(id));
    const r = await c.match(clave, { ignoreSearch: false });
    if (r) return r;
  }
  return null;
}

async function guardarEnCache(peticion, respuesta) {
  const id = await versionActiva();
  if (!id || !respuesta || respuesta.status !== 200 || respuesta.type !== "basic") return;
  // Los archivos de onnxruntime (ort/, unos 40 MB) ya los guarda transformers.js en su propia
  // caché («transformers-cache», que este service worker nunca borra): no se duplican aquí.
  const ruta = new URL(typeof peticion === "string" ? peticion : peticion.url).pathname;
  if (ruta.startsWith(new URL("ort/", self.registration.scope).pathname)) return;
  try {
    const c = await caches.open(nombreCache(id));
    await c.put(peticion, respuesta.clone());
  } catch {
    // sin espacio: no impide servir la respuesta
  }
}

async function responder(evento, url) {
  const peticion = evento.request;
  // version.json: siempre de la red; sin conexión, la copia guardada.
  if (url.href === urlDe("version.json")) {
    try {
      return conCabeceras(await fetch(peticion, { cache: "no-store" }));
    } catch {
      return conCabeceras((await desdeCache(urlDe("version.json"))) || new Response("{}", { headers: { "Content-Type": "application/json" } }));
    }
  }
  // Navegación dentro del ámbito: la página única, desde la caché de la versión activa.
  if (peticion.mode === "navigate") {
    const guardada = (await desdeCache(urlDe("index.html"))) || (await desdeCache(urlDe("./")));
    if (guardada) return conCabeceras(guardada);
    try {
      const r = await fetch(peticion);
      if (r.ok) await guardarEnCache(urlDe("index.html"), r);
      return conCabeceras(r);
    } catch {
      return conCabeceras(paginaSinConexion());
    }
  }
  // Resto de archivos propios: caché y, si no está, red (y se guarda).
  const guardada = await desdeCache(peticion);
  if (guardada) return conCabeceras(guardada, url);
  try {
    const r = await fetch(peticion);
    await guardarEnCache(peticion, r);
    return conCabeceras(r, url);
  } catch (e) {
    return new Response("", { status: 504, statusText: "Sin conexión" });
  }
}

self.addEventListener("fetch", (evento) => {
  const peticion = evento.request;
  if (peticion.method !== "GET") return;
  const url = new URL(peticion.url);
  // Otros orígenes (autoridades de sellado, huggingface.co...): sin tocar.
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(self.registration.scope)) return;
  // Peticiones parciales (Range): directas a la red.
  if (peticion.headers.has("range")) return;
  evento.respondWith(responder(evento, url));
});
