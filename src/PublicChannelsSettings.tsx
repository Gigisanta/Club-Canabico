import { toast } from "sonner";
import { send, useResource } from "./lib";
import { Field, Form, Panel } from "./ui";

type Channels = { whatsappPhone: string; instagramUrl: string };
export default function PublicChannelsSettings() {
  const resource = useResource<Channels>("/site/admin/channels");
  async function save(form: FormData) {
    await send("/site/admin/channels", {
      whatsappPhone: String(form.get("whatsappPhone") || ""),
      instagramUrl: String(form.get("instagramUrl") || ""),
    }, "PUT");
    toast.success("Canales actualizados");
    await resource.reload();
  }
  return <Panel title="Canales oficiales" sub="Los enlaces se muestran en la web solo cuando tienen un valor validado.">
    <div className="settings-form">
      {resource.loading && !resource.data && <p role="status">Cargando canales…</p>}
      {resource.error && <p role="alert" className="form-error">{resource.error}</p>}
      {resource.data && <Form onSubmit={save} submit="Guardar canales"><Field label="WhatsApp oficial" hint="Número internacional con código de país. Por ejemplo: 5491123456789. Dejalo vacío para ocultar el enlace."><input name="whatsappPhone" type="tel" inputMode="tel" defaultValue={resource.data.whatsappPhone} autoComplete="off" /></Field><Field label="Instagram oficial" hint="URL completa del perfil oficial. Dejalo vacío para ocultar el enlace."><input name="instagramUrl" type="url" placeholder="https://www.instagram.com/…" defaultValue={resource.data.instagramUrl} autoComplete="off" /></Field><p className="note-box">Las consultas se guardan primero en la bandeja privada. Si configurás WhatsApp, después se abrirá con un mensaje genérico sin datos personales.</p></Form>}
    </div>
  </Panel>;
}
