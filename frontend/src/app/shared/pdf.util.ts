// Escapa texto para interpolar sin riesgo dentro de HTML (texto o atributos).
// Estas páginas se abren con document.write en una ventana del MISMO origen y
// corren un <script> inline: un dato sin escapar (nombre, comentario, servicio)
// sería XSS con acceso al token en localStorage. Todo valor dinámico DEBE pasar por acá.
export function escapeHtml(v: any): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

// `titulo` se escapa acá como red de seguridad. `contenido` es HTML por diseño
// (tablas, barras): cada valor dinámico que arme el llamador debe venir ya escapado
// con escapeHtml() — no se puede escapar el bloque entero sin romper el maquetado.
export async function generarPDF(titulo: string, contenido: string, logoUrl = 'assets/logo/ms-iso.png') {
  titulo = escapeHtml(titulo);
  let logoBase64 = '';
  try {
    const resp = await fetch(logoUrl);
    const blob = await resp.blob();
    logoBase64 = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  } catch { /* sin logo si falla */ }

  const ventana = window.open('', '_blank');
  if (!ventana) return;

  ventana.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${titulo}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; padding: 32px; font-size: 13px; }
    .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #e11d48; padding-bottom: 16px; margin-bottom: 24px; }
    .header h1 { font-size: 22px; font-weight: 800; color: #e11d48; }
    .header .fecha { font-size: 12px; color: #737373; }
    .header .logo { font-size: 18px; font-weight: 800; color: #e11d48; display: flex; align-items: center; gap: 10px; }
    .header .logo img { height: 48px; width: auto; }
    .section { margin-bottom: 20px; }
    .section-title { font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; color: #e11d48; margin-bottom: 10px; border-bottom: 1px solid #e5e5e5; padding-bottom: 6px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .kpi { border: 1px solid #e5e5e5; border-radius: 10px; padding: 14px; text-align: center; }
    .kpi .num { font-size: 26px; font-weight: 900; color: #e11d48; }
    .kpi .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #737373; margin-top: 4px; }
    .kpi.green .num { color: #047857; }
    .kpi.amber .num { color: #b45309; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { text-align: left; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; color: #737373; padding: 8px 10px; border-bottom: 2px solid #e5e5e5; }
    td { padding: 8px 10px; border-bottom: 1px solid #f0f0f0; font-size: 12px; }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: 'Courier New', monospace; }
    .right { text-align: right; }
    .bold { font-weight: 700; }
    .bar-wrap { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .bar-label { width: 140px; font-size: 11px; color: #525252; flex-shrink: 0; }
    .bar-track { flex: 1; height: 10px; background: #f0f0f0; border-radius: 999px; overflow: hidden; }
    .bar-fill { height: 100%; background: #e11d48; border-radius: 999px; }
    .bar-val { width: 40px; font-size: 11px; font-weight: 700; text-align: right; flex-shrink: 0; }
    .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e5e5e5; font-size: 10px; color: #a3a3a3; text-align: center; }
    @media print { body { padding: 16px; } .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <span class="logo">${logoBase64 ? `<img src="${logoBase64}" alt="Logo" />` : ''}MS Motos</span>
      <h1>${titulo}</h1>
    </div>
    <div class="fecha">${new Date().toLocaleDateString('es-CR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
  </div>
  ${contenido}
  <div class="footer">Generado automáticamente por MS Motos · ${new Date().toLocaleString('es-CR')}</div>
  <script>window.onload = function() { window.print(); }</script>
</body>
</html>`);
  ventana.document.close();
}

export function formatMoneda(n: number): string {
  return '₡' + (n || 0).toLocaleString('es-CR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function formatPct(parte: number, total: number): string {
  return total ? Math.round((parte / total) * 100) + '%' : '0%';
}
