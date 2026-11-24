// Monitoreo Internos UL — API de bases compartidas (Netlify Functions v2 + Netlify Blobs)
//
//  GET    /api/ping                         -> { ok, admin }  (admin = existe ADMIN_KEY)
//  GET    /api/auth           [x-admin-key] -> 200 si la clave es correcta, 401 si no
//  GET    /api/data                         -> { ok, tools: { tool1: manifiesto, ... } }
//  GET    /api/data?tool=X                  -> manifiesto del módulo X (404 si no hay datos)
//  PUT    /api/data?tool=X&slot=S [admin]   -> registra la base S del módulo X (reemplaza la anterior)
//  DELETE /api/data?tool=X        [admin]   -> borra todas las bases del módulo X
//  PUT    /api/chunk?tool&slot&uid&f&c [admin] -> guarda una parte (≤ 5 MB) de un archivo
//  GET    /api/chunk?tool&slot&uid&f&c      -> devuelve esa parte
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const STORE_NAME = "monitoreo-internos-ul";
const MAX_CHUNK = 5 * 1024 * 1024;
const RE = {
  tool: /^tool[0-9]{1,2}$/,
  slot: /^[A-Za-z][A-Za-z0-9_-]{0,39}$/,
  uid: /^[a-z0-9]{8,40}$/,
  int: /^[0-9]{1,3}$/
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
const fail = (status, error) => json({ ok: false, error }, status);

function env(name) {
  try { return (globalThis.Netlify && Netlify.env.get(name)) || process.env[name] || ""; }
  catch (e) { return process.env[name] || ""; }
}
const adminKey = () => env("ADMIN_KEY");
// Claves opcionales por persona: cada una solo puede cargar las bases de su canal en el módulo SOS
const KEYS_POR_PERSONA = {
  ADMIN_KEY_MT: ["tool3:fileBase", "tool3:filePareto"],      // Modern Trade
  ADMIN_KEY_TT: ["tool3:fileBaseTT", "tool3:fileParetoTT"]   // Tradicional
};
// Devuelve "all" (clave principal), la lista "modulo:base" permitida, o null
function scopeDe(req) {
  const k = req.headers.get("x-admin-key") || "";
  if (!k) return null;
  if (adminKey() && k === adminKey()) return "all";
  const sc = Object.entries(KEYS_POR_PERSONA).filter(([v]) => env(v) && env(v) === k).flatMap(([, l]) => l);
  return sc.length ? sc : null;
}
function isAdmin(req, tool, slot) {
  const sc = scopeDe(req);
  if (sc === "all") return true;
  return Array.isArray(sc) && !!slot && sc.includes(tool + ":" + slot);
}
const hayClaves = () => !!adminKey() || Object.keys(KEYS_POR_PERSONA).some(v => !!env(v));
const limpiar = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, "").slice(0, n);

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const q = (k) => url.searchParams.get(k) || "";
  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  try {
    if (route === "ping") return json({ ok: true, admin: !!adminKey() });

    if (route === "auth") {
      if (!hayClaves()) return fail(500, "Falta configurar ADMIN_KEY en Netlify (y hacer Trigger deploy).");
      const sc = scopeDe(req);
      return sc ? json({ ok: true, scope: sc }) : fail(401, "Clave incorrecta");
    }

    if (route === "data") {
      const tool = q("tool");
      if (req.method === "GET") {
        if (!tool) {
          const { blobs } = await store.list({ prefix: "manifest/" });
          const tools = {};
          for (const b of blobs) {
            const m = await store.get(b.key, { type: "json" });
            if (m) tools[b.key.slice("manifest/".length)] = m;
          }
          return json({ ok: true, tools });
        }
        if (!RE.tool.test(tool)) return fail(400, "Módulo inválido");
        const m = await store.get("manifest/" + tool, { type: "json" });
        return m ? json(m) : fail(404, "Todavía no hay datos cargados");
      }

      if (!hayClaves()) return fail(500, "Falta configurar ADMIN_KEY en Netlify.");
      if (!RE.tool.test(tool)) return fail(400, "Módulo inválido");
      // PUT: la persona solo puede reemplazar sus bases; DELETE (borrar todo el módulo): solo la clave principal
      if (!isAdmin(req, tool, req.method === "PUT" ? q("slot") : null)) return fail(401, scopeDe(req) ? "Esta clave no puede cargar esta base" : "Clave de administradora incorrecta o faltante");

      if (req.method === "PUT") {
        const slot = q("slot");
        if (!RE.slot.test(slot)) return fail(400, "Base inválida");
        let body;
        try { body = await req.json(); } catch (e) { return fail(400, "JSON inválido"); }
        const uid = String(body && body.uid || "");
        const files = Array.isArray(body && body.files) ? body.files : [];
        if (!RE.uid.test(uid)) return fail(400, "Identificador de carga inválido");
        if (!files.length || files.length > 20) return fail(400, "Cantidad de archivos inválida");
        const limpios = [];
        for (let fi = 0; fi < files.length; fi++) {
          const f = files[fi] || {};
          const chunks = Number(f.chunks);
          if (!Number.isInteger(chunks) || chunks < 1 || chunks > 500) return fail(400, "Partes inválidas");
          for (let ci = 0; ci < chunks; ci++) {
            const meta = await store.getMetadata(`file/${tool}/${slot}/${uid}/${fi}/${ci}`);
            if (!meta) return fail(400, `Falta la parte ${ci + 1} de ${limpiar(f.name, 80)}. Vuelve a subir el archivo.`);
          }
          limpios.push({
            name: limpiar(f.name || "archivo", 200), type: limpiar(f.type, 100),
            size: Number(f.size) || 0, lastModified: Number(f.lastModified) || Date.now(),
            gz: !!f.gz, chunks
          });
        }
        const key = "manifest/" + tool;
        const m = (await store.get(key, { type: "json" })) || { tool, items: {} };
        const seq = Object.values(m.items || {}).reduce((a, i) => Math.max(a, i.seq || 0), 0) + 1;
        const fecha = new Date().toISOString();
        m.items = m.items || {};
        m.items[slot] = { uid, seq, fecha, files: limpios };   // la carga nueva reemplaza a la anterior
        m.actualizado = fecha;
        await store.setJSON(key, m);
        // elimina las partes de cargas anteriores de esta misma base
        const { blobs } = await store.list({ prefix: `file/${tool}/${slot}/` });
        for (const b of blobs) if (!b.key.startsWith(`file/${tool}/${slot}/${uid}/`)) await store.delete(b.key);
        return json({ ok: true, manifest: m });
      }

      if (req.method === "DELETE") {
        await store.delete("manifest/" + tool);
        const { blobs } = await store.list({ prefix: `file/${tool}/` });
        for (const b of blobs) await store.delete(b.key);
        return json({ ok: true });
      }
      return fail(405, "Método no permitido");
    }

    if (route === "chunk") {
      const tool = q("tool"), slot = q("slot"), uid = q("uid"), f = q("f"), c = q("c");
      if (!RE.tool.test(tool) || !RE.slot.test(slot) || !RE.uid.test(uid) || !RE.int.test(f) || !RE.int.test(c)) return fail(400, "Parámetros inválidos");
      const key = `file/${tool}/${slot}/${uid}/${Number(f)}/${Number(c)}`;
      if (req.method === "GET") {
        const buf = await store.get(key, { type: "arrayBuffer" });
        if (!buf) return fail(404, "Parte no encontrada");
        return new Response(buf, { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
      }
      if (req.method === "PUT") {
        if (!hayClaves()) return fail(500, "Falta configurar ADMIN_KEY en Netlify.");
        if (!isAdmin(req, tool, slot)) return fail(401, scopeDe(req) ? "Esta clave no puede cargar esta base" : "Clave de administradora incorrecta o faltante");
        const buf = await req.arrayBuffer();
        if (!buf.byteLength) return fail(400, "Parte vacía");
        if (buf.byteLength > MAX_CHUNK) return fail(413, "Parte demasiado grande");
        await store.set(key, buf);
        return json({ ok: true, size: buf.byteLength });
      }
      return fail(405, "Método no permitido");
    }

    return fail(404, "Ruta no encontrada");
  } catch (e) {
    console.error(e);
    return fail(500, "Error del servidor: " + (e && e.message || e));
  }
};
