import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ShieldCheck } from "@phosphor-icons/react";
import { send, type User } from "./lib";
import { Brand, Field, Form } from "./ui";

type Invitation = { name: string; email: string; role: string; expiresAt: string };

export default function ActivateAccess({ onLogin }: { onLogin: (user: User) => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (!token) { setError("Falta el enlace de activación."); return; }
    void send<Invitation>("/auth/invitation", { token })
      .then((value) => { if (active) setInvitation(value); })
      .catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [token]);
  return <main className="login-page activate-page">
    <div className="login-story"><Brand /><div><span className="eyebrow">BOMBO · ACCESO PRIVADO</span><h1>Tu club,<br />a mano.</h1><p>Activá tu acceso personal y elegí una contraseña.</p></div><small>Una cuenta por persona.</small></div>
    <section className="login-form"><Brand /><ShieldCheck size={30} weight="duotone" aria-hidden="true" /><h2>Activar acceso</h2>
      {error ? <><p role="alert">{error}</p><Link className="button" to="/app">Volver al ingreso</Link></> : !invitation ? <p role="status">Verificando enlace…</p> : <>
        <p><strong>{invitation.name}</strong> · {invitation.email}</p>
        <Form submit="Activar y entrar" onSubmit={async (fd) => {
          const password = String(fd.get("password") || "");
          if (password !== fd.get("confirm")) throw new Error("Las contraseñas no coinciden.");
          const { user } = await send<{ user: User }>("/auth/activate", { token, password });
          onLogin(user);
          navigate("/app", { replace: true });
        }}>
          <Field label="Contraseña"><input name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required /></Field>
          <Field label="Repetir contraseña"><input name="confirm" type="password" minLength={12} maxLength={72} autoComplete="new-password" required /></Field>
        </Form><p className="login-note">Usá 12 caracteres o más. El enlace vence a las 48 horas y se usa una sola vez.</p>
      </>}
    </section>
  </main>;
}
