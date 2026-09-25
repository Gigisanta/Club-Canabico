import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, ArrowUpRight, InstagramLogo, List, X } from "@phosphor-icons/react";
import { send, useResource } from "./lib";

type Channels = { whatsappAvailable: boolean; instagramUrl: string | null };
type Item = { slug: string; title: string; category: string; description: string; imageUrl: string | null };
type ShowcaseState = { loading: boolean; loaded: boolean; error: string; reload: () => Promise<void> };

const categories = [
  { name: "Flores", image: "/brand/flores.webp", detail: "Una mirada a la diversidad botánica." },
  { name: "Aceites", image: "/brand/aceite.webp", detail: "Formatos y presentaciones para conocer." },
  { name: "Tópicos", image: "/brand/topicos.webp", detail: "Texturas y presentaciones de la categoría." },
  { name: "Comestibles", image: "/brand/comestibles.webp", detail: "Distintas formas de presentar la categoría." },
];

function normalizeCategory(value: string) {
  return value.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es-AR");
}

function validatedWhatsAppUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.origin !== "https://wa.me" || url.username || url.password || url.port || !/^\/[1-9]\d{6,14}$/.test(url.pathname) || url.hash) return null;
    if (url.searchParams.size !== 1 || url.searchParams.get("text") !== "Hola Bombo, envié una consulta desde la web.") return null;
    return url.href;
  } catch {
    return null;
  }
}

function PublicHeader({ channels }: { channels: Channels | null }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const previousLocation = useRef(`${location.pathname}${location.hash}`);

  useEffect(() => {
    const currentLocation = `${location.pathname}${location.hash}`;
    if (previousLocation.current !== currentLocation) {
      previousLocation.current = currentLocation;
      if (open) {
        setOpen(false);
        window.requestAnimationFrame(() => buttonRef.current?.focus());
      }
    }
  }, [location.pathname, location.hash, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 761px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  function closeMenu() {
    if (!open) return;
    setOpen(false);
    if (window.matchMedia("(max-width: 760px)").matches)
      window.requestAnimationFrame(() => buttonRef.current?.focus());
  }

  return <header className="public-header">
    <a className="public-skip-link" href="#contenido">Saltar al contenido</a>
    <Link className="public-logo" to="/" aria-label="Bombo, inicio"><img src="/brand/bombo-olive.webp" alt="Bombo" width="760" height="181" /></Link>
    <button
      ref={buttonRef}
      type="button"
      className="public-menu-button"
      aria-label={open ? "Cerrar menú" : "Abrir menú"}
      aria-expanded={open}
      aria-controls="public-primary-navigation"
      onClick={() => setOpen(value => !value)}
    >{open ? <X aria-hidden="true" /> : <List aria-hidden="true" />}</button>
    <nav id="public-primary-navigation" className={`public-navigation${open ? " open" : ""}`} aria-label="Navegación principal">
      <Link to="/#club" onClick={closeMenu}>El club</Link>
      <Link to="/productos" onClick={closeMenu}>Vidriera</Link>
      <Link to="/#contacto" onClick={closeMenu}>Contacto</Link>
      {channels?.instagramUrl && <a href={channels.instagramUrl} target="_blank" rel="noopener noreferrer" aria-label="Instagram oficial"><InstagramLogo size={21} aria-hidden="true" /></a>}
      <Link className="public-team-link" to="/app" onClick={closeMenu}>Acceso equipo <ArrowUpRight size={16} aria-hidden="true" /></Link>
    </nav>
  </header>;
}

function ContactForm({ interest = "Información sobre el club", source = "web" }: { interest?: string; source?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [whatsappHref, setWhatsappHref] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || saved) return;
    setBusy(true);
    setError("");
    setSuccessMessage("");
    setWhatsappHref(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    let persisted = false;

    try {
      const result = await send<{ saved: boolean; whatsappUrl: string | null }>("/site/inquiries", {
        name: String(data.get("name") || ""), contact: String(data.get("contact") || ""),
        interest: String(data.get("interest") || ""), message: String(data.get("message") || ""),
        source, consent: data.get("consent") === "on", website: String(data.get("website") || ""),
      });
      if (!result.saved) throw new Error("No pudimos guardar la consulta");

      persisted = true;
      const approvedWhatsAppUrl = validatedWhatsAppUrl(result.whatsappUrl);
      form.reset();
      setSaved(true);
      setWhatsappHref(approvedWhatsAppUrl);
      setSuccessMessage(approvedWhatsAppUrl
        ? "Tu consulta quedó guardada. Si querés, podés continuar por WhatsApp oficial."
        : "Tu consulta quedó guardada. El equipo podrá responderte por el contacto que compartiste.");
    } catch (cause) {
      if (persisted) {
        setSaved(true);
        setSuccessMessage("Tu consulta quedó guardada. El equipo podrá responderte por el contacto que compartiste.");
      } else {
        setError((cause as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return <form className="public-contact-form" onSubmit={submit}>
    <div className="public-form-grid">
      <label>Tu nombre<input name="name" required minLength={2} maxLength={100} autoComplete="name" /></label>
      <label>Correo o teléfono<input name="contact" required minLength={5} maxLength={160} autoComplete="email" /></label>
    </div>
    <label>Tu interés<input name="interest" required minLength={2} maxLength={100} defaultValue={interest.slice(0, 100)} /></label>
    <label>Mensaje<textarea name="message" required minLength={10} maxLength={2000} rows={4} placeholder="Contanos en qué podemos ayudarte" /></label>
    <label className="public-consent"><input type="checkbox" name="consent" required /> Acepto que Bombo use estos datos para responder mi consulta.</label>
    <input className="public-honeypot" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
    <p className="public-privacy-note">No compartas información de salud en este formulario. Los datos quedan en la bandeja privada del equipo.</p>
    {error && <p role="alert" className="public-form-error">{error}</p>}
    {saved && <div role="status" aria-live="polite" className="public-form-success"><p>{successMessage}</p>{whatsappHref && <a className="public-button public-button-dark public-whatsapp-link" href={whatsappHref} target="_blank" rel="noopener noreferrer">Continuar por WhatsApp <ArrowRight aria-hidden="true" /></a>}</div>}
    <button type="submit" disabled={busy || saved} className="public-button public-button-dark">{busy ? "Guardando…" : saved ? "Consulta enviada" : "Enviar consulta"}<ArrowRight aria-hidden="true" /></button>
  </form>;
}

function ProductCard({ item }: { item: Item }) {
  return <Link className="public-product-card" to={`/productos/${item.slug}`}>
    <div className="public-product-image">{item.imageUrl ? <img src={item.imageUrl} alt={item.title} loading="lazy" width="900" height="750" /> : <img src="/brand/bombo-symbol.png" alt="" loading="lazy" width="192" height="192" />}</div>
    <div className="public-product-copy"><span>{item.category}</span><h3>{item.title}</h3><p>{item.description}</p><strong>Conocer ficha <ArrowUpRight size={18} aria-hidden="true" /></strong></div>
  </Link>;
}

function DataMessage({
  kind, eyebrow, title, children, action,
}: {
  kind: "loading" | "error" | "empty";
  eyebrow: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const role = kind === "error" ? "alert" : "status";
  return <div className={`public-data-message public-data-message-${kind}`} role={role} aria-live={kind === "error" ? "assertive" : "polite"}>
    <span className="public-section-number">{eyebrow}</span>
    <div className="public-data-message-copy"><h2>{title}</h2><div className="public-data-message-description">{children}</div></div>
    {action && <div className="public-data-message-actions">{action}</div>}
  </div>;
}

function Home({ channels, items, showcase }: { channels: Channels | null; items: Item[]; showcase: ShowcaseState }) {
  return <main id="contenido" className="public-main" tabIndex={-1}>
    <section className="public-hero" aria-labelledby="public-hero-title">
      <figure className="public-hero-image">
        <img src="/brand/home.webp" alt="Siluetas de hojas frente a la luz cálida del atardecer." width="1600" height="1067" fetchPriority="high" />
        <figcaption><span>Una identidad para compartir</span><span>Bombo · El club</span></figcaption>
      </figure>
      <div className="public-hero-copy">
        <p className="public-kicker"><span aria-hidden="true" /> EL CLUB DE BOMBO</p>
        <h1 id="public-hero-title"><span>Un lugar para</span><em>encontrarnos.</em></h1>
        <p className="public-lede">Identidad, comunidad y una forma cercana de compartir información sobre el proyecto.</p>
        <div className="public-hero-actions"><a className="public-button" href="#club">Conocé el club <ArrowRight aria-hidden="true" /></a><Link className="public-text-link" to="/productos">Explorar vidriera <ArrowUpRight aria-hidden="true" /></Link></div>
      </div>
    </section>

    <section className="public-intro" id="club" aria-labelledby="public-club-title">
      <div className="public-intro-heading"><span className="public-section-number">EL CLUB</span><h2 id="public-club-title">El nombre que<br /><em>nos reúne.</em></h2></div>
      <div className="public-intro-body"><p>Bombo es un espacio para conocer el proyecto del club, sus categorías y las personas detrás. Esta web está en preparación; el equipo puede responder tus preguntas desde el formulario.</p><a href="#contacto" className="public-inline-link">Escribinos <ArrowUpRight aria-hidden="true" /></a></div>
    </section>

    <section className="public-categories" id="categorias" aria-labelledby="public-categories-title">
      <div className="public-section-heading"><div><span className="public-section-number">CATEGORÍAS</span><h2 id="public-categories-title">Un universo<br /><em>para explorar.</em></h2></div><p>Recorré las categorías y abrí las fichas que el equipo haya publicado.</p></div>
      <div className="public-category-grid">{categories.map((category, index) => <Link key={category.name} to={`/productos?categoria=${encodeURIComponent(category.name)}`} className={`public-category-card public-category-card-${index + 1}`}><div className="public-category-image"><picture><source media="(max-width: 760px)" srcSet={category.image.replace(/\.webp$/, "-mobile.webp")} /><img src={category.image} alt={category.name} loading="lazy" width="900" height="600" /></picture></div><div className="public-category-copy"><span>{category.name}</span><h3>{category.name}<ArrowUpRight aria-hidden="true" /></h3><p>{category.detail}</p></div></Link>)}</div>
    </section>

    <section className="public-story" aria-labelledby="public-story-title">
      <figure className="public-story-image"><picture><source media="(max-width: 760px)" srcSet="/brand/club-mobile.webp" /><img src="/brand/club.webp" alt="Una escena del universo visual del club Bombo." loading="lazy" width="1600" height="1067" /></picture><figcaption>El club, de cerca</figcaption></figure>
      <div className="public-story-copy"><span className="public-section-number">UNA FORMA DE ENCONTRARNOS</span><h2 id="public-story-title">Más cerca,<br /><em>más claro.</em></h2><p>Queremos que cada conversación empiece con información clara y una respuesta humana. Mirá la vidriera o escribí directamente al equipo.</p><Link className="public-button public-button-light" to="/productos">Ver la vidriera <ArrowRight aria-hidden="true" /></Link></div>
    </section>

    <section className="public-featured" aria-labelledby="public-featured-title" aria-busy={showcase.loading && !showcase.loaded}>
      <div className="public-section-heading public-featured-heading"><div><span className="public-section-number">VIDRIERA CURADA</span><h2 id="public-featured-title">Fichas del club.</h2></div><Link className="public-inline-link" to="/productos">Ver todas <ArrowUpRight aria-hidden="true" /></Link></div>
      {showcase.error && showcase.loaded && <p className="public-inline-error" role="status">No se pudo actualizar la vidriera. <button type="button" onClick={() => void showcase.reload()}>Reintentar</button></p>}
      {showcase.loading && !showcase.loaded
        ? <DataMessage kind="loading" eyebrow="VIDRIERA" title="Cargando fichas…">En un momento vas a poder recorrer la selección del equipo.</DataMessage>
        : showcase.error && !showcase.loaded
          ? <DataMessage kind="error" eyebrow="VIDRIERA" title="No pudimos cargar las fichas.">Probá de nuevo para consultar la selección publicada.<button className="public-inline-link" type="button" onClick={() => void showcase.reload()}>Reintentar <ArrowRight aria-hidden="true" /></button></DataMessage>
          : items.length
            ? <div className="public-products-grid">{items.slice(0, 3).map(item => <ProductCard key={item.slug} item={item} />)}</div>
            : <DataMessage kind="empty" eyebrow="VIDRIERA" title="Las primeras fichas están en preparación.">Mientras tanto, podés recorrer las categorías o escribirle al equipo.<Link className="public-inline-link" to="/productos">Explorar categorías <ArrowRight aria-hidden="true" /></Link></DataMessage>}
    </section>

    <section className="public-contact" id="contacto" aria-labelledby="public-contact-title">
      <div className="public-contact-copy"><span className="public-section-number">HABLEMOS</span><h2 id="public-contact-title">¿Querés saber<br />más de Bombo?</h2><p>Dejanos una consulta y el equipo la recibirá en su bandeja privada.</p>{channels?.whatsappAvailable && <p>Después de guardar tu consulta, vas a poder continuar por WhatsApp oficial.</p>}</div>
      <ContactForm source="home" />
    </section>
  </main>;
}

function Catalog({ items, showcase }: { items: Item[]; showcase: ShowcaseState }) {
  const [params, setParams] = useSearchParams();
  const category = params.get("categoria") || "Todas";
  const allSelected = normalizeCategory(category) === normalizeCategory("Todas");
  const availableCategories = Array.from(new Map(
    [...categories.map(item => item.name), ...items.map(item => item.category.trim()).filter(Boolean)]
      .map(name => [normalizeCategory(name), name]),
  ).values());
  const filtered = allSelected ? items : items.filter(item => normalizeCategory(item.category) === normalizeCategory(category));

  function updateCategory(name: string) {
    const next = new URLSearchParams(params);
    if (normalizeCategory(name) === normalizeCategory("Todas")) next.delete("categoria");
    else next.set("categoria", name);
    setParams(next);
  }

  return <main id="contenido" className="public-page public-catalog" tabIndex={-1} aria-busy={showcase.loading && !showcase.loaded}>
    <div className="public-page-heading"><span className="public-section-number">BOMBO / VIDRIERA</span><h1>Lo que queremos<br /><em>compartir.</em></h1><p>Fichas seleccionadas por el equipo. Escribinos para conocer más; la vidriera no informa precios ni disponibilidad.</p></div>
    <div className="public-filter" role="group" aria-label="Filtrar fichas por categoría">
      {["Todas", ...availableCategories].map(name => <button type="button" key={normalizeCategory(name)} className={(name === "Todas" ? allSelected : normalizeCategory(category) === normalizeCategory(name)) ? "active" : ""} aria-pressed={name === "Todas" ? allSelected : normalizeCategory(category) === normalizeCategory(name)} onClick={() => updateCategory(name)}>{name}</button>)}
    </div>
    {showcase.error && showcase.loaded && <p className="public-inline-error" role="status">No se pudo actualizar la vidriera. <button type="button" onClick={() => void showcase.reload()}>Reintentar</button></p>}
    {showcase.loading && !showcase.loaded
      ? <DataMessage kind="loading" eyebrow="VIDRIERA" title="Cargando fichas…">La selección publicada aparecerá acá.</DataMessage>
      : showcase.error && !showcase.loaded
        ? <DataMessage kind="error" eyebrow="VIDRIERA" title="No pudimos cargar la vidriera.">La conexión puede estar momentáneamente interrumpida.<button className="public-inline-link" type="button" onClick={() => void showcase.reload()}>Reintentar <ArrowRight aria-hidden="true" /></button></DataMessage>
        : filtered.length
          ? <><p className="public-result-count" aria-live="polite">{filtered.length} {filtered.length === 1 ? "ficha" : "fichas"}</p><div className="public-products-grid">{filtered.map(item => <ProductCard key={item.slug} item={item} />)}</div></>
          : <DataMessage kind="empty" eyebrow="SIN RESULTADOS" title={allSelected ? "Todavía no hay fichas publicadas." : `Todavía no hay fichas en “${category}”.`}>{allSelected ? "La selección del equipo aparecerá acá cuando esté publicada." : "Probá otra categoría o volvé a ver todas las fichas."}<div className="public-data-message-actions-inner">{!allSelected && <button type="button" className="public-button public-button-dark" onClick={() => updateCategory("Todas")}>Ver todas las fichas <ArrowRight aria-hidden="true" /></button>}<Link className="public-text-link" to="/#contacto">Consultar al equipo <ArrowUpRight aria-hidden="true" /></Link></div></DataMessage>}
  </main>;
}

function ProductDetail() {
  const { slug } = useParams();
  const detail = useResource<Item>(slug ? `/site/showcase/${encodeURIComponent(slug)}` : null);
  if (detail.loading && !detail.data) return <main id="contenido" className="public-page public-detail-state" tabIndex={-1} role="status" aria-live="polite">Cargando ficha…</main>;
  if (detail.error || !detail.data) return <main id="contenido" className="public-page public-detail-state" tabIndex={-1}>
    <Link className="public-back" to="/productos">← Volver a la vidriera</Link>
    <DataMessage kind="error" eyebrow="FICHA" title="No pudimos mostrar esta ficha.">Puede estar en preparación o no estar disponible en este momento.<button className="public-inline-link" type="button" onClick={() => void detail.reload()}>Reintentar <ArrowRight aria-hidden="true" /></button></DataMessage>
  </main>;

  const item = detail.data;
  return <main id="contenido" className="public-page public-detail-page" tabIndex={-1}>
    <Link className="public-back" to="/productos">← Volver a la vidriera</Link>
    <div className="public-detail">
      <div className="public-detail-image">{item.imageUrl ? <img src={item.imageUrl} alt={item.title} width="1200" height="1200" /> : <img src="/brand/bombo-symbol.png" alt="" width="192" height="192" />}</div>
      <div className="public-detail-copy"><span className="public-section-number">{item.category}</span><h1>{item.title}</h1><p>{item.description}</p><a className="public-button public-button-dark" href="#consulta-producto">Consultar sobre esta ficha <ArrowRight aria-hidden="true" /></a><p className="public-detail-note">Información editorial. Consultá con el equipo para recibir una respuesta personalizada.</p></div>
    </div>
    <section className="public-contact public-detail-contact" id="consulta-producto" aria-labelledby="public-detail-contact-title"><div className="public-contact-copy"><span className="public-section-number">TU CONSULTA</span><h2 id="public-detail-contact-title">Hablemos sobre<br />{item.title}.</h2><p>Tu consulta llega al equipo de Bombo antes de abrir cualquier canal externo.</p></div><ContactForm interest={item.title} source={`producto:${item.slug}`} /></section>
  </main>;
}

function PublicFooter({ channels }: { channels: Channels | null }) {
  return <footer className="public-footer">
    <div className="public-footer-brand"><Link to="/" aria-label="Bombo, inicio"><img src="/brand/bombo-white.webp" alt="Bombo" width="760" height="181" /></Link><p>Una identidad para encontrarnos.</p></div>
    <div className="public-footer-links"><span>EXPLORAR</span><Link to="/#club">El club</Link><Link to="/productos">Vidriera</Link><Link to="/#contacto">Contacto</Link></div>
    <div className="public-footer-links"><span>SEGUINOS</span>{channels?.instagramUrl ? <a href={channels.instagramUrl} target="_blank" rel="noopener noreferrer">Instagram <ArrowUpRight size={14} aria-hidden="true" /></a> : <p>Canales oficiales en preparación.</p>}<Link to="/app">Acceso del equipo</Link></div>
    <small>© {new Date().getFullYear()} Bombo · Vista previa</small>
  </footer>;
}

function PublicSiteContent() {
  const location = useLocation();
  const channels = useResource<Channels>("/site");
  const showcase = useResource<{ items: Item[] }>("/site/showcase");
  const isDetail = location.pathname.startsWith("/productos/");
  const isCatalog = location.pathname === "/productos";
  const items = showcase.data?.items || [];
  const showcaseState: ShowcaseState = { loading: showcase.loading, loaded: showcase.data !== null, error: showcase.error, reload: showcase.reload };

  useEffect(() => {
    const hash = location.hash.slice(1);
    if (hash) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());
  }, [location.pathname, location.hash]);

  return <div className="public-site"><PublicHeader channels={channels.data} />{isDetail ? <ProductDetail key={location.pathname} /> : isCatalog ? <Catalog items={items} showcase={showcaseState} /> : <Home channels={channels.data} items={items} showcase={showcaseState} />}<PublicFooter channels={channels.data} /></div>;
}

export function PublicSite() {
  if (import.meta.env.PROD && import.meta.env.VITE_PUBLIC_SITE_APPROVED !== "true")
    return <div className="public-hold"><img src="/brand/bombo-olive.webp" alt="Bombo" /><h1>Estamos preparando este espacio.</h1><p>La web del club estará disponible después de la revisión del equipo.</p><Link to="/app">Acceso del equipo <ArrowRight aria-hidden="true" /></Link></div>;
  return <PublicSiteContent />;
}
