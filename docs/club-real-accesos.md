# Bombo · espacio real y accesos

## Estado local, 28 de septiembre de 2026

- La instancia de demostración en `127.0.0.1:5173` usa `raiz_demo` y conserva únicamente su función de prueba.
- La instancia real local en `127.0.0.1:3003` sirve el frontend compilado y usa `bombo_real`, con rol PostgreSQL propio y secretos en `.local/real-club.env` (archivo privado, ignorado por Git).
- `bombo_real` arranca con el nombre **Bombo cannabis club** y sin socios, lotes, ventas, gastos ni usuarios activos. Reserva Tiziano como dueño y Camila y Gio como gerentes. Ningún dato de la demo se copió.
- El acceso se activa con correo real y un enlace de un solo uso, válido por 48 horas. La persona elige su contraseña. Hasta entonces la reserva figura como **Falta correo**; no hay cuenta con la que se pueda iniciar sesión.
- `PUBLIC_SITE_APPROVED=false` y `CLUB_OPERATIONS_APPROVED=false` permanecen bloqueados. AppSheet sigue siendo la fuente de delivery.

Para volver a iniciarla desde la raíz del proyecto: `npm run build && npm run club:start-local`. El proceso queda activo mientras la terminal siga abierta. La base PostgreSQL local debe estar iniciada.

## Terminar las tres altas

1. Definir `APP_ORIGIN` con la URL definitiva HTTPS de la app privada. Mientras el uso sea solo local, el archivo privado usa `http://127.0.0.1:3003`.
2. Desde la raíz del proyecto, con cada correo recibido, ejecutar `TEAM_ENV_FILE=.local/real-club.env npm run team:invite -- tiziano CORREO`, sustituyendo `tiziano` por `camila` o `gio` según corresponda. El comando guarda el enlace en `.local/invitaciones/` con permisos de solo usuario; no lo imprime en el terminal.
3. Entregar cada enlace a la persona indicada por un canal privado. El correo no se verifica por otro mecanismo: confirmar el destinatario antes de compartirlo. La app no manda emails automáticamente.
4. Cada persona abre su enlace, define su propia contraseña y entra. Verificar **Configuración → Equipo** y que el enlace usado ya no sirve. Tiziano puede renovar enlaces y agregar nuevos miembros desde la app.

## Paso a servicio remoto

Esta instancia local ejecuta el build de producción, pero está aislada en loopback y usa HTTP solo en esta Mac. Todavía no es un servicio accesible para Tiziano y Camila desde fuera de ella. Falta definir dominio, hosting PostgreSQL, HTTPS, copias externas y un remitente de invitaciones si se desea envío automático. No se debe reutilizar la base `raiz_demo` ni publicar la web editorial antes de su aprobación. Los datos reales de AppSheet/Sheets/caja deben recibirse y conciliarse antes de interpretar resultados o habilitar operaciones reguladas.
