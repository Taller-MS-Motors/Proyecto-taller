// Respuesta de error centralizada: loguea el detalle real en el servidor
// y devuelve un mensaje genérico al cliente (no filtra mensajes internos/SQL).

// Errores de MySQL que en realidad describen un dato inválido del cliente, no una
// falla del servidor. Devolverlos como 500 tiene dos costos: el cliente no puede
// distinguir "mandé mal los datos" de "el sistema está caído", y en el monitoreo un
// formulario mal llenado se ve igual que una caída real. Salió de la prueba de carga:
// referencias inexistentes generaban 500 y disparaban la tasa de error al 6%.
const POR_DATO_INVALIDO = {
  // FK que apunta a una fila que no existe (cliente_id, moto_id… inventados).
  ER_NO_REFERENCED_ROW: 'Alguno de los datos relacionados no existe',
  ER_NO_REFERENCED_ROW_2: 'Alguno de los datos relacionados no existe',
  // Borrar algo de lo que todavía cuelgan otras filas.
  ER_ROW_IS_REFERENCED: 'No se puede eliminar: hay registros que dependen de esto',
  ER_ROW_IS_REFERENCED_2: 'No se puede eliminar: hay registros que dependen de esto',
  // Único duplicado (correo repetido, placa repetida…).
  ER_DUP_ENTRY: 'Ese valor ya existe',
  // Texto más largo que la columna, o fuera del rango del ENUM.
  ER_DATA_TOO_LONG: 'Alguno de los valores es demasiado largo',
  WARN_DATA_TRUNCATED: 'Alguno de los valores no es válido',
  ER_TRUNCATED_WRONG_VALUE: 'Alguno de los valores no tiene el formato esperado',
  ER_BAD_NULL_ERROR: 'Falta un dato obligatorio',
};

function fail(res, err, status = 500) {
  const mensaje = POR_DATO_INVALIDO[err?.code];
  if (mensaje && status === 500) {
    // Se loguea igual, pero como aviso: sirve para detectar validaciones que faltan
    // en una ruta, sin ensuciar los errores de verdad.
    console.warn(`Dato inválido (${err.code}):`, err?.sqlMessage || err?.message);
    return res.status(400).json({ error: mensaje });
  }
  console.error('Error:', err?.message || err);
  res.status(status).json({ error: 'Error interno del servidor' });
}

module.exports = { fail };
