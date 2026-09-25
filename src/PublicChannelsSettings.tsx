import { CircleNotch, Eye, EyeSlash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { send, useResource } from "./lib";
import { Field, Form, Panel } from "./ui";
import "./site-admin.css";

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

  return (
    <div className="presence-admin presence-channels-admin">
      <Panel
        title="Canales oficiales"
        sub="Los enlaces aparecen en la vista previa sólo cuando están configurados y validados."
        className="presence-settings-panel presence-channels-panel"
      >
        <div className="presence-channel-content">
          <div className="presence-channel-summary" aria-label="Visibilidad actual de los canales">
            <div className="presence-channel-summary-copy">
              <span className="presence-kicker">ESTADO DE LA VISTA PREVIA</span>
              <strong>Canales del club</strong>
              <p>Dejá un canal vacío para mantenerlo oculto.</p>
            </div>
            {resource.data && (
              <div className="presence-channel-states">
                <span className={`presence-channel-state ${resource.data.whatsappPhone ? "is-visible" : "is-hidden"}`}>
                  {resource.data.whatsappPhone ? <Eye aria-hidden="true" /> : <EyeSlash aria-hidden="true" />}
                  WhatsApp · {resource.data.whatsappPhone ? "Configurado" : "Oculto"}
                </span>
                <span className={`presence-channel-state ${resource.data.instagramUrl ? "is-visible" : "is-hidden"}`}>
                  {resource.data.instagramUrl ? <Eye aria-hidden="true" /> : <EyeSlash aria-hidden="true" />}
                  Instagram · {resource.data.instagramUrl ? "Configurado" : "Oculto"}
                </span>
              </div>
            )}
          </div>

          {resource.loading && !resource.data && (
            <div className="presence-feedback presence-loading" role="status">
              <CircleNotch className="presence-spinner" aria-hidden="true" />
              <span>Cargando canales…</span>
            </div>
          )}

          {resource.error && (
            <div className="presence-feedback presence-error" role="alert">
              <div>
                <strong>No se pudo cargar la configuración</strong>
                <p>{resource.error}</p>
              </div>
              <button className="button" type="button" onClick={() => void resource.reload()}>
                Reintentar
              </button>
            </div>
          )}

          {resource.data && (
            <Form onSubmit={save} submit="Guardar canales">
              <div className="presence-channel-fields">
                <Field
                  label="WhatsApp oficial"
                  hint="Número internacional de 8 a 15 dígitos, con código de país. Podés escribirlo con + o espacios; dejalo vacío para ocultar el acceso."
                >
                  <input
                    name="whatsappPhone"
                    type="tel"
                    inputMode="tel"
                    maxLength={30}
                    defaultValue={resource.data.whatsappPhone}
                    autoComplete="off"
                    placeholder="+54 9 11 2345 6789"
                  />
                </Field>
                <Field
                  label="Instagram oficial"
                  hint="Se acepta el perfil oficial en instagram.com con HTTPS. Dejalo vacío para ocultar el enlace."
                >
                  <input
                    name="instagramUrl"
                    type="url"
                    maxLength={250}
                    placeholder="https://www.instagram.com/tu-perfil"
                    defaultValue={resource.data.instagramUrl}
                    autoComplete="url"
                  />
                </Field>
              </div>

              <div className="presence-channel-note">
                <strong>Las consultas llegan primero a la bandeja privada.</strong>
                <p>Si configurás WhatsApp, se abre después con un mensaje genérico, sin incluir datos personales.</p>
              </div>
            </Form>
          )}
        </div>
      </Panel>
    </div>
  );
}
