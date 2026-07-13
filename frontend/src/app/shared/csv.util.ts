// Genera y descarga un CSV a partir de filas de objetos. Se abre directo en Excel.
// Usa BOM UTF-8 para que Excel respete los acentos y ; como separador (locale es).

export function descargarCSV(nombreArchivo: string, columnas: { key: string; label: string }[], filas: any[]) {
  const sep = ';';
  const escapar = (v: any) => {
    if (v === null || v === undefined) return '';
    const s0 = String(v);
    // Anti inyección de fórmulas (CSV injection): un valor que empieza con = + - @
    // (o tab/CR) puede ejecutarse como fórmula al abrir el CSV en Excel/Sheets. Se le
    // antepone un apóstrofo, salvo que sea un número legítimo (no romper negativos).
    const peligroso = /^[=+\-@\t\r]/.test(s0) && !/^-?\d+([.,]\d+)?$/.test(s0);
    const s = (peligroso ? "'" + s0 : s0).replace(/"/g, '""');
    return /[";\n]/.test(s) ? `"${s}"` : s;
  };

  const encabezado = columnas.map(c => escapar(c.label)).join(sep);
  const cuerpo = filas.map(fila => columnas.map(c => escapar(fila[c.key])).join(sep)).join('\n');
  const contenido = '﻿' + encabezado + '\n' + cuerpo;

  const blob = new Blob([contenido], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo.endsWith('.csv') ? nombreArchivo : `${nombreArchivo}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Formatea una fecha ISO a dd/MM/yyyy para los reportes (vacío si no hay fecha).
export function fechaCorta(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-CR');
}
