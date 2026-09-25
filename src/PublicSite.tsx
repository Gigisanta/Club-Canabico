import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, ArrowUpRight, InstagramLogo, List, X } from "@phosphor-icons/react";
import { send, useResource } from "./lib";

type Channels = { whatsappAvailable: boolean; instagramUrl: string | null };
type Item = { slug: string; title: string; category: string; description: string; imageUrl: string | null };
const categories = [
  { name: "Flores", image: "/brand/flores.webp", detail: "Una mirada a la diversidad botánica." },
  { name: "Aceites", image: "/brand/aceite.webp", detail: "Formatos para conocer y explorar." },
  { name: "Tópicos", image: "/brand/topicos.webp", detail: "Texturas, formulaciones y cuidado." },
  { name: "Comestibles", image: "/brand/comestibles.webp", detail: "Otra forma de presentar la categoría." },
];

function PublicHeader({ channels }: { channels: Channels | null }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        document.querySelector<HTMLButtonElement>(".public-menu-button")?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);
  return <header className="public-header">
    <a className="public-skip-link" href="#contenido">Saltar al contenido</a>
    <Link className="public-logo" to="/" aria-label="Bombo, inicio"><img src="/brand/bombo-olive.webp" alt="Bombo" /></Link>
    <button type="button" className="public-menu-button" aria-label={open ? "Cerrar menú" : "Abrir menú"} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <X /> : <List />}</button>
    <nav className={open ? "open" : ""} aria-label="Navegación principal">
      <Link to="/#club">El club</Link>
      <Link to="/productos">Vidriera</Link>
      <Link to="/#contacto">Contacto</Link>
      {channels?.instagramUrl && <a href={channels.instagramUrl} target="_blank" rel="noopener noreferrer" aria-label="Instagram oficial"><InstagramLogo size={21} /></a>}
      <Link className="public-team-link" to="/app">Acceso equipo <ArrowUpRight size={16} /></Link>
    </nav>
  </header>;
}

function ContactForm({ interest = "Información sobre el club", source = "web" }: { interest?: string; source?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || saved) return;
    setBusy(true); setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await send<{ saved: boolean; whatsappUrl: string | null }>("/site/inquiries", {
        name: String(data.get("name") || ""), contact: String(data.get("contact") || ""),
        interest: String(data.get("interest") || ""), message: String(data.get("message") || ""),
        source, consent: data.get("consent") === "on", website: String(data.get("website") || ""),
      });
      if (!result.saved) throw new Error("No pudimos guardar la consulta");
      form.reset();
      setSaved(true);
      if (result.whatsappUrl) window.location.assign(result.whatsappUrl);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <form className="public-contact-form" onSubmit={submit}>
    <div className="public-form-grid">
      <label>Tu nombre<input name="name" required minLength={2} maxLength={100} autoComplete="name" /></label>
      <label>Correo o teléfono<input name="contact" required minLength={5} maxLength={160} autoComplete="email" /></label>
    </div>
    <label>Tu interés<input name="interest" required minLength={2} maxLength={100} defaultValue={interest} /></label>
    <label>Mensaje<textarea name="message" required minLength={10} maxLength={2000} rows={4} placeholder="Contanos en qué podemos ayudarte" /></label>
    <label className="public-consent"><input type="checkbox" name="consent" required /> Acepto que Bombo use estos datos para responder mi consulta.</label>
    <input className="public-honeypot" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
    <p className="public-privacy-note">No compartas información de salud en este formulario. Los datos quedan en la bandeja privada del equipo.</p>
    {error && <p role="alert" className="public-form-error">{error}</p>}
    {saved && <p role="status" className="public-form-success">Tu consulta quedó guardada. El equipo de Bombo podrá responderte.</p>}
    <button type="submit" disabled={busy || saved} className="public-button public-button-dark">{busy ? "Guardando…" : saved ? "Consulta enviada" : "Enviar consulta"}<ArrowRight /></button>
  </form>;
}

function ProductCard({ item }: { item: Item }) {
  return <Link className="public-product-card" to={`/productos/${item.slug}`}>
    <div className="public-product-image">{item.imageUrl ? <img src={item.imageUrl} alt={item.title} loading="lazy" /> : <img src="/brand/bombo-symbol.png" alt="" />}</div>
    <div><span>{item.category}</span><h3>{item.title}</h3><p>{item.description}</p><strong>Conocer ficha <ArrowUpRight size={18} /></strong></div>
  </Link>;
}

function Home({ channels, items }: { channels: Channels | null; items: Item[] }) {
  return <main id="contenido">
    <section className="public-hero">
      <div className="public-hero-copy"><p className="public-kicker"><span /> EL CLUB DE BOMBO</p><h1>Un lugar para<br /><em>encontrarnos.</em></h1><p className="public-lede">Identidad, comunidad y una forma cercana de compartir información sobre el proyecto.</p><div className="public-hero-actions"><a className="public-button" href="#club">Conocé el club <ArrowRight /></a><Link className="public-text-link" to="/productos">Explorar vidriera <ArrowUpRight /></Link></div><div className="public-hero-note"><span>01 / 03</span><i /><span>Una identidad para compartir</span></div></div>
      <div className="public-hero-image"><img src="/brand/home.webp" alt="Imagen de referencia visual del universo Bombo" /><div className="public-hero-sticker"><img src="/brand/bombo-symbol.png" alt="" /><span>HECHO PARA<br />ENCONTRARNOS</span></div></div>
    </section>
    <section className="public-intro" id="club"><div><span className="public-section-number">01 — EL CLUB</span><h2>El nombre que nos reúne.</h2></div><div><p>Bombo es un espacio para conocer el proyecto del club, sus categorías y las personas detrás. Esta web está en preparación; el equipo puede responder tus preguntas desde el formulario.</p><a href="#contacto" className="public-inline-link">Escribinos <ArrowUpRight /></a></div></section>
    <section className="public-categories" id="categorias"><div className="public-section-heading"><span className="public-section-number">02 — CATEGORÍAS</span><h2>Un universo para explorar.</h2><p>Imágenes y categorías de referencia del material de marca. Las fichas publicadas se curan por separado.</p></div><div className="public-category-grid">{categories.map((category, index) => <Link key={category.name} to={`/productos?categoria=${encodeURIComponent(category.name)}`} className="public-category-card"><img src={category.image} alt={`Referencia visual: ${category.name}`} loading="lazy" /><span>0{index + 1} / {category.name}</span><h3>{category.name}<ArrowUpRight /></h3><p>{category.detail}</p></Link>)}</div></section>
    <section className="public-story"><div className="public-story-image"><img src="/brand/club.webp" alt="Imagen de referencia del club Bombo" loading="lazy" /></div><div className="public-story-copy"><span className="public-section-number">03 — NUESTRA FORMA</span><h2>Más cerca,<br />más claro.</h2><p>Queremos que cada conversación empiece con información clara y una respuesta humana. Mirá la vidriera curada o escribí directamente al equipo.</p><Link className="public-button public-button-light" to="/productos">Ver la vidriera <ArrowRight /></Link></div></section>
    <section className="public-steps"><div className="public-section-heading"><span className="public-section-number">PARA QUIENES QUIEREN CONOCERNOS</span><h2>Empezá por acá.</h2><p>Un recorrido simple para acercarte al proyecto, sin trámites automáticos desde esta web.</p></div><div className="public-steps-grid"><article><span>01</span><h3>Conocé</h3><p>Explorá el club, las categorías y las fichas que el equipo haya publicado.</p></article><article><span>02</span><h3>Consultá</h3><p>Contanos qué te interesa. Tu mensaje se guarda en una bandeja privada.</p></article><article><span>03</span><h3>Conversemos</h3><p>El equipo podrá responderte por el canal de contacto que compartiste.</p></article></div></section>
    <section className="public-featured"><div className="public-section-heading"><span className="public-section-number">VIDRIERA CURADA</span><h2>Fichas del club.</h2><Link className="public-inline-link" to="/productos">Ver todas <ArrowUpRight /></Link></div>{items.length ? <div className="public-products-grid">{items.slice(0, 3).map(item => <ProductCard key={item.slug} item={item} />)}</div> : <div className="public-empty">Estamos preparando las primeras fichas. Mientras tanto, podés conocer las categorías y escribirnos.</div>}</section>
    <section className="public-contact" id="contacto"><div className="public-contact-copy"><span className="public-section-number">HABLEMOS</span><h2>¿Querés saber<br />más de Bombo?</h2><p>Dejanos una consulta y el equipo la recibirá en su bandeja privada.</p>{channels?.whatsappAvailable && <p>Después de guardarla, podrás continuar por WhatsApp oficial.</p>}</div><ContactForm source="home" /></section>
  </main>;
}

function Catalog({ items }: { items: Item[] }) {
  const [params, setParams] = useSearchParams();
  const category = params.get("categoria") || "Todas";
  const filtered = category === "Todas" ? items : items.filter(item => item.category.toLocaleLowerCase("es") === category.toLocaleLowerCase("es"));
  return <main id="contenido" className="public-page"><div className="public-page-heading"><span className="public-section-number">BOMBO / VIDRIERA</span><h1>Lo que queremos<br /><em>compartir.</em></h1><p>Fichas seleccionadas por el equipo. Consultá por más información; esta página no muestra disponibilidad ni precios.</p></div><div className="public-filter" aria-label="Filtrar categorías">{["Todas", ...categories.map(c => c.name)].map(name => <button type="button" key={name} className={category === name ? "active" : ""} aria-pressed={category === name} onClick={() => setParams(name === "Todas" ? {} : { categoria: name })}>{name}</button>)}</div>{filtered.length ? <div className="public-products-grid">{filtered.map(item => <ProductCard key={item.slug} item={item} />)}</div> : <div className="public-empty">Todavía no hay fichas publicadas para esta categoría. <Link to="/#contacto">Podés consultarnos.</Link></div>}</main>;
}

function ProductDetail() {
  const { slug } = useParams();
  const detail = useResource<Item>(slug ? `/site/showcase/${encodeURIComponent(slug)}` : null);
  if (detail.loading) return <main id="contenido" className="public-page" role="status">Cargando ficha…</main>;
  if (detail.error || !detail.data) return <main id="contenido" className="public-page"><h1>Ficha no disponible</h1><p>La ficha puede estar en preparación.</p><Link to="/productos" className="public-inline-link">Volver a la vidriera <ArrowRight /></Link></main>;
  const item = detail.data;
  return <main id="contenido" className="public-page"><Link className="public-back" to="/productos">← Volver a la vidriera</Link><div className="public-detail"><div className="public-detail-image">{item.imageUrl && <img src={item.imageUrl} alt={item.title} />}</div><div><span className="public-section-number">{item.category}</span><h1>{item.title}</h1><p>{item.description}</p><a className="public-button public-button-dark" href="#consulta-producto">Consultar sobre esta ficha <ArrowRight /></a><p className="public-detail-note">Información editorial. Consultá con el equipo para recibir una respuesta personalizada.</p></div></div><section className="public-contact public-detail-contact" id="consulta-producto"><div className="public-contact-copy"><span className="public-section-number">TU CONSULTA</span><h2>Hablemos sobre<br />{item.title}.</h2><p>Tu consulta llega al equipo de Bombo antes de abrir cualquier canal externo.</p></div><ContactForm interest={item.title} source={`producto:${item.slug}`} /></section></main>;
}

function PublicSiteContent() {
  const location = useLocation();
  const channels = useResource<Channels>("/site");
  const showcase = useResource<{ items: Item[] }>("/site/showcase");
  const isDetail = location.pathname.startsWith("/productos/");
  const isCatalog = location.pathname === "/productos";
  useEffect(() => {
    const hash = location.hash.slice(1);
    if (hash) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());
  }, [location.pathname, location.hash]);
  return <div className="public-site"><PublicHeader channels={channels.data} />{isDetail ? <ProductDetail /> : isCatalog ? <Catalog items={showcase.data?.items || []} /> : <Home channels={channels.data} items={showcase.data?.items || []} />}{showcase.error && !isDetail && <div className="public-data-error" role="alert">No se pudieron cargar las fichas. <button onClick={() => void showcase.reload()}>Reintentar</button></div>}<footer className="public-footer"><div><Link to="/"><img src="/brand/bombo-white.webp" alt="Bombo" /></Link><p>Una identidad para encontrarnos.</p></div><div><span>EXPLORAR</span><Link to="/#club">El club</Link><Link to="/productos">Vidriera</Link><Link to="/#contacto">Contacto</Link></div><div><span>INFORMACIÓN</span><a href="https://www.argentina.gob.ar/salud/cannabis-medicinal/reprocann" target="_blank" rel="noopener noreferrer">Información oficial sobre REPROCANN <ArrowUpRight size={14} /></a>{channels.data?.instagramUrl && <a href={channels.data.instagramUrl} target="_blank" rel="noopener noreferrer">Instagram <ArrowUpRight size={14} /></a>}<Link to="/app">Acceso del equipo</Link></div><small>© {new Date().getFullYear()} Bombo · Vista previa</small></footer></div>;
}

export function PublicSite() {
  if (import.meta.env.PROD && import.meta.env.VITE_PUBLIC_SITE_APPROVED !== "true")
    return <div className="public-hold"><img src="/brand/bombo-olive.webp" alt="Bombo" /><h1>Estamos preparando este espacio.</h1><p>La web del club estará disponible después de la revisión del equipo.</p><Link to="/app">Acceso del equipo <ArrowRight /></Link></div>;
  return <PublicSiteContent />;
}
