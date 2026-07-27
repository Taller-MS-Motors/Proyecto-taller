// Envío de correos vía Resend (API HTTP, sin SMTP).
// Degradación segura: sin RESEND_API_KEY solo loguea (modo desarrollo), nunca lanza.

const RESEND_API_URL = 'https://api.resend.com/emails';

// Logo de la cabecera. En un correo no sirve incrustar la imagen (Gmail y compañía
// descartan las data: URI), así que se enlaza desde el mismo dominio que sirve la app.
// La base se deduce sola: en Railway sale de RAILWAY_PUBLIC_DOMAIN, y cuando tengamos
// dominio propio basta con definir APP_URL. Sin base pública (desarrollo local) no se
// pone <img> y la cabecera queda como antes, en texto.
function baseUrlPublica() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

function logoUrl() {
  if (process.env.MAIL_LOGO_URL) return process.env.MAIL_LOGO_URL;
  const base = baseUrlPublica();
  return base ? `${base}/assets/logo/ms-logo-white.png` : null;
}

// ─────────────────────────────────────────────────────────────
// Núcleo de envío. Todas las plantillas pasan por acá.
// Devuelve true si el correo salió (o si estamos en modo dev sin API key);
// false ante un rechazo/red. Nunca lanza.
// ─────────────────────────────────────────────────────────────
async function enviarCorreo({ to, subject, html, devLog }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Taller MS <onboarding@resend.dev>';

  if (!to) return false;

  if (!apiKey) {
    console.log(`📧 [DEV] ${devLog || `Email a ${to}: ${subject}`}`);
    return true;
  }

  // Aviso útil: con el remitente de prueba de Resend solo se entrega al correo dueño
  // de la cuenta. Para enviar a cualquier destinatario hay que verificar un dominio
  // y poner MAIL_FROM con una dirección de ese dominio.
  if (from.includes('resend.dev')) {
    console.warn('⚠️  MAIL_FROM usa el remitente de prueba (resend.dev): Resend SOLO entregará al correo verificado de la cuenta. Verificá un dominio y definí MAIL_FROM para enviar a cualquier cuenta.');
  }

  try {
    const resp = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!resp.ok) {
      const detalle = await resp.text().catch(() => '');
      console.error(`⚠️  Resend rechazó el envío a ${to}:`, resp.status, detalle);
      if (resp.status === 403 || /testing|verify a domain|own email/i.test(detalle)) {
        console.error('   → Causa típica: dominio sin verificar en Resend. Verificá un dominio y definí MAIL_FROM (p. ej. "MS Motos <no-reply@TU-DOMINIO>").');
      }
      return false;
    }
    return true;
  } catch (err) {
    console.error(`⚠️  Error enviando correo a ${to}:`, err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Plantillas (mismo lenguaje visual oscuro del taller).
// ─────────────────────────────────────────────────────────────

// Envoltorio común: tarjeta oscura con encabezado del taller.
function envoltorio(taller, titulo, cuerpoHtml) {
  const nombre = escapar(taller || 'MS Motos');
  const logo = logoUrl();

  // El alt del logo lleva el nombre del taller con el mismo estilo que el rótulo de
  // texto: si el cliente de correo bloquea imágenes (Outlook lo hace por defecto),
  // la cabecera se sigue leyendo igual que antes en vez de quedar un hueco.
  const cabecera = logo
    ? `<img src="${logo}" width="72" height="72" alt="${nombre}"
           style="display:block;border:0;outline:none;text-decoration:none;width:72px;height:72px;
                  color:#e11d48;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">`
    : `<div style="color:#e11d48;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${nombre}</div>`;

  return `
  <div style="background:#0a0a0a;padding:32px 0;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
    <div style="max-width:460px;margin:0 auto;background:#171717;border-radius:24px;overflow:hidden;border:1px solid #262626;">
      <div style="padding:24px 32px 8px;">
        ${cabecera}
        <h1 style="color:#fafafa;font-size:22px;margin:14px 0 6px;">${escapar(titulo)}</h1>
      </div>
      <div style="padding:4px 32px 30px;">${cuerpoHtml}</div>
    </div>
  </div>`;
}

function parrafo(texto) {
  return `<p style="color:#a3a3a3;font-size:14px;line-height:1.6;margin:0 0 12px;">${texto}</p>`;
}

// Escapa texto de usuario para no romper el HTML del correo.
function escapar(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plantillaCodigo(nombre, codigo) {
  const cuerpo = `
    ${parrafo(`Hola${nombre ? ' ' + escapar(nombre) : ''}, usá este código para restablecer tu contraseña. Vence en 10 minutos.`)}
    <div style="text-align:center;padding:12px 0 8px;">
      <div style="display:inline-block;background:#0a0a0a;border:1px solid #be123c;border-radius:16px;padding:18px 28px;">
        <span style="color:#fafafa;font-size:38px;font-weight:700;letter-spacing:10px;font-family:'JetBrains Mono','Courier New',monospace;">${escapar(codigo)}</span>
      </div>
    </div>
    <p style="color:#737373;font-size:12px;line-height:1.5;margin:12px 0 0;">
      Si no pediste este cambio, podés ignorar este correo. Nadie podrá cambiar tu contraseña sin este código.
    </p>`;
  return envoltorio('Taller MS', 'Recuperá tu contraseña', cuerpo);
}

function plantillaCodigoLogin(nombre, codigo) {
  const cuerpo = `
    ${parrafo(`Hola${nombre ? ' ' + escapar(nombre) : ''}, usá este código para ingresar a tu cuenta. Vence en 10 minutos.`)}
    <div style="text-align:center;padding:12px 0 8px;">
      <div style="display:inline-block;background:#0a0a0a;border:1px solid #be123c;border-radius:16px;padding:18px 28px;">
        <span style="color:#fafafa;font-size:38px;font-weight:700;letter-spacing:10px;font-family:'JetBrains Mono','Courier New',monospace;">${escapar(codigo)}</span>
      </div>
    </div>
    <p style="color:#737373;font-size:12px;line-height:1.5;margin:12px 0 0;">
      Si no intentaste ingresar, ignorá este correo. Nadie puede entrar a tu cuenta sin este código.
    </p>`;
  return envoltorio('Taller MS', 'Tu código de ingreso', cuerpo);
}

function plantillaCodigoVerificacion(nombre, codigo) {
  const cuerpo = `
    ${parrafo(`Hola${nombre ? ' ' + escapar(nombre) : ''}, ¡bienvenido! Usá este código para confirmar tu correo y activar tu cuenta. Vence en 10 minutos.`)}
    <div style="text-align:center;padding:12px 0 8px;">
      <div style="display:inline-block;background:#0a0a0a;border:1px solid #be123c;border-radius:16px;padding:18px 28px;">
        <span style="color:#fafafa;font-size:38px;font-weight:700;letter-spacing:10px;font-family:'JetBrains Mono','Courier New',monospace;">${escapar(codigo)}</span>
      </div>
    </div>
    <p style="color:#737373;font-size:12px;line-height:1.5;margin:12px 0 0;">
      Si no creaste esta cuenta, podés ignorar este correo.
    </p>`;
  return envoltorio('Taller MS', 'Confirmá tu correo', cuerpo);
}

function plantillaRecordatorio({ nombre, hora, servicio, moto, sucursal, taller }) {
  const donde = sucursal ? ` en ${escapar(sucursal)}` : '';
  const cuerpo = `
    ${parrafo(`Hola${nombre ? ' ' + escapar(nombre) : ''}, te recordamos tu cita para <strong style="color:#fafafa;">mañana a las ${escapar(hora)}</strong>${donde}.`)}
    <div style="background:#0a0a0a;border:1px solid #262626;border-radius:16px;padding:16px 20px;margin:8px 0 12px;">
      <p style="color:#737373;font-size:12px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">Servicio</p>
      <p style="color:#fafafa;font-size:15px;margin:0 0 10px;">${escapar(servicio)}</p>
      <p style="color:#737373;font-size:12px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">Moto</p>
      <p style="color:#fafafa;font-size:15px;margin:0;">${escapar(moto)}</p>
    </div>
    ${parrafo('Si no podés asistir, avisanos para reprogramar. ¡Te esperamos!')}`;
  return envoltorio(taller, 'Recordatorio de tu cita', cuerpo);
}

// Aviso de hito del servicio (lista para entrega / entregada).
function plantillaEstado({ nombre, titulo, mensaje, taller }) {
  const cuerpo = `
    ${parrafo(`Hola${nombre ? ' ' + escapar(nombre) : ''},`)}
    ${parrafo(escapar(mensaje))}
    ${parrafo('Gracias por confiar en nosotros.')}`;
  return envoltorio(taller, titulo, cuerpo);
}

// ─────────────────────────────────────────────────────────────
// API pública (una función por tipo de correo).
// ─────────────────────────────────────────────────────────────

async function enviarCodigoReset(email, nombre, codigo) {
  return enviarCorreo({
    to: email,
    subject: 'Tu código para recuperar la contraseña',
    html: plantillaCodigo(nombre, codigo),
    devLog: `Código de recuperación para ${email}: ${codigo}`,
  });
}

// Código de ingreso sin contraseña (OTP) para el portal del cliente.
async function enviarCodigoLogin(email, nombre, codigo) {
  return enviarCorreo({
    to: email,
    subject: 'Tu código de ingreso',
    html: plantillaCodigoLogin(nombre, codigo),
    devLog: `Código de ingreso para ${email}: ${codigo}`,
  });
}

// Código para confirmar el correo al auto-registrarse en el portal.
async function enviarCodigoVerificacion(email, nombre, codigo) {
  return enviarCorreo({
    to: email,
    subject: 'Confirmá tu correo',
    html: plantillaCodigoVerificacion(nombre, codigo),
    devLog: `Código de verificación para ${email}: ${codigo}`,
  });
}

// Recordatorio de la cita del día siguiente.
async function enviarRecordatorioCita(email, datos) {
  return enviarCorreo({
    to: email,
    subject: `Recordatorio: tu cita es mañana a las ${datos.hora}`,
    html: plantillaRecordatorio(datos),
    devLog: `Recordatorio de cita a ${email}: mañana ${datos.hora} (${datos.servicio})`,
  });
}

// Aviso al cliente de un hito de su servicio (listo / entregado).
async function enviarAvisoEstado(email, datos) {
  return enviarCorreo({
    to: email,
    subject: datos.titulo,
    html: plantillaEstado(datos),
    devLog: `Aviso "${datos.titulo}" a ${email}`,
  });
}

module.exports = {
  enviarCorreo, enviarCodigoReset, enviarCodigoLogin, enviarCodigoVerificacion,
  enviarRecordatorioCita, enviarAvisoEstado,
};
