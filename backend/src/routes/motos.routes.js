const router = require('express').Router();
const { pool } = require('../db/pool');
const { fail } = require('../utils/responder');
const auth = require('../middleware/auth');
const { anioValido, placaValida } = require('../utils/validar');

router.use(auth);

router.get('/', async (req, res) => {
  try {
    const { q, cliente_id } = req.query;
    // Columnas explícitas SIN la foto base64 (MEDIUMTEXT): este listado es global y
    // sin paginar, así que devolver la imagen de cada moto haría respuestas enormes.
    // Se expone `tiene_foto`; la imagen se obtiene en el detalle (GET /motos/:id).
    let sql = `SELECT m.id, m.cliente_id, m.marca, m.modelo, m.anio, m.placa, m.color,
                      m.numero_motor, m.numero_chasis, m.kilometraje_actual, m.foto_url,
                      m.activa, m.created_at, m.updated_at,
                      (m.foto IS NOT NULL) AS tiene_foto,
                      c.nombre AS cliente_nombre, c.apellido AS cliente_apellido, c.telefono AS cliente_telefono
               FROM motos m JOIN clientes c ON m.cliente_id = c.id WHERE m.activa = 1`;
    const params = [];
    if (cliente_id) { sql += ' AND m.cliente_id = ?'; params.push(cliente_id); }
    if (q) {
      sql += ' AND (m.marca LIKE ? OR m.modelo LIKE ? OR m.placa LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    sql += ' ORDER BY m.created_at DESC';
    const [rows] = await pool.query(sql, params);
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    const { cliente_id, marca, modelo, anio, placa, color, numero_motor, numero_chasis, kilometraje_actual, foto_url } = req.body;
    if (!cliente_id || !marca || !modelo) {
      return res.status(400).json({ error: 'cliente_id, marca y modelo son requeridos' });
    }
    if (!placaValida(placa)) return res.status(400).json({ error: 'La placa no tiene un formato válido' });
    if (!anioValido(anio)) return res.status(400).json({ error: 'El año no es válido' });
    // Evita placas duplicadas (normaliza espacios y guiones), igual que en el portal.
    if (placa) {
      const [[dup]] = await pool.query(
        `SELECT id FROM motos WHERE activa = 1
           AND UPPER(REPLACE(REPLACE(placa, ' ', ''), '-', '')) = UPPER(REPLACE(REPLACE(?, ' ', ''), '-', ''))`,
        [placa]
      );
      if (dup) return res.status(409).json({ error: 'Esa placa ya está registrada' });
    }
    const [result] = await pool.query(
      `INSERT INTO motos (cliente_id, marca, modelo, anio, placa, color, numero_motor, numero_chasis, kilometraje_actual, foto_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cliente_id, marca, modelo, anio || null, placa || null, color || null, numero_motor || null, numero_chasis || null, kilometraje_actual || 0, foto_url || null]
    );
    const [[nueva]] = await pool.query('SELECT * FROM motos WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: nueva, message: 'Moto registrada' });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [[moto]] = await pool.query(
      `SELECT m.*, c.nombre AS cliente_nombre, c.apellido AS cliente_apellido, c.telefono AS cliente_telefono
       FROM motos m JOIN clientes c ON m.cliente_id = c.id WHERE m.id = ? AND m.activa = 1`,
      [req.params.id]
    );
    if (!moto) return res.status(404).json({ error: 'Moto no encontrada' });
    res.json({ data: moto });
  } catch (err) {
    fail(res, err);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { marca, modelo, anio, placa, color, numero_motor, numero_chasis, kilometraje_actual, foto_url } = req.body;
    if (!placaValida(placa)) return res.status(400).json({ error: 'La placa no tiene un formato válido' });
    if (!anioValido(anio)) return res.status(400).json({ error: 'El año no es válido' });
    await pool.query(
      `UPDATE motos SET marca=?, modelo=?, anio=?, placa=?, color=?, numero_motor=?, numero_chasis=?, kilometraje_actual=?, foto_url=?
       WHERE id=?`,
      [marca, modelo, anio || null, placa || null, color || null, numero_motor || null, numero_chasis || null, kilometraje_actual || 0, foto_url || null, req.params.id]
    );
    const [[actualizada]] = await pool.query('SELECT * FROM motos WHERE id = ?', [req.params.id]);
    res.json({ data: actualizada, message: 'Moto actualizada' });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/:id/historial', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ot.id, ot.numero_orden, ot.estado, ot.problema_reportado, ot.fecha_ingreso, ot.fecha_entrega_real,
              ot.costo_mano_obra, ot.costo_repuestos, ot.descuento,
              (ot.costo_mano_obra + ot.costo_repuestos - ot.descuento) AS total,
              u.nombre AS tecnico_nombre
       FROM ordenes_trabajo ot
       LEFT JOIN usuarios u ON ot.tecnico_id = u.id
       WHERE ot.moto_id = ?
       ORDER BY ot.fecha_ingreso DESC`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
