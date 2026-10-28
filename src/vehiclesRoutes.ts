import { Router, Request, Response } from 'express';
import { pool } from './database';
import { requireFamilyPermission } from './accessControl';

const router = Router();

function addMonthsToDateStr(dateStr: string, monthsToAdd: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + monthsToAdd, 1));
  const maxDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, maxDay));
  return target.toISOString().slice(0, 10);
}

// 1. LISTAR VEÍCULOS E HISTÓRICO DE ABASTECIMENTO / MANUTENÇÃO DA FAMÍLIA
router.get(
  '/overview',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    try {
      const [vehiclesRes, recordsRes] = await Promise.all([
        pool.query(
          `SELECT id, family_id, nickname, vehicle_type, brand_model,
                  manufacture_year, model_year, license_plate, fuel_type,
                  current_odometer, fipe_estimated_value, ipva_estimated_amount,
                  ipva_due_month, insurance_provider, insurance_policy_number,
                  TO_CHAR(insurance_renewal_date, 'YYYY-MM-DD') AS insurance_renewal_date,
                  insurance_annual_amount, insurance_assistance_phone,
                  next_revision_km,
                  TO_CHAR(next_revision_date, 'YYYY-MM-DD') AS next_revision_date,
                  status, notes, created_at, updated_at
           FROM family_vehicles
           WHERE family_id = $1
           ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 WHEN status = 'INACTIVE' THEN 1 ELSE 2 END,
                    nickname ASC`,
          [familyId]
        ),
        pool.query(
          `SELECT id, family_id, vehicle_id, record_type, title, service_category,
                  TO_CHAR(record_date, 'YYYY-MM-DD') AS record_date,
                  odometer_km, liters, price_per_liter, fuel_efficiency_kml,
                  amount, provider_name, next_service_km,
                  TO_CHAR(next_service_date, 'YYYY-MM-DD') AS next_service_date,
                  financial_transaction_id, notes, created_at
           FROM vehicle_records
           WHERE family_id = $1
           ORDER BY record_date DESC, id DESC
           LIMIT 300`,
          [familyId]
        ),
      ]);

      return res.json({
        vehicles: vehiclesRes.rows.map(v => ({
          ...v,
          current_odometer: Number(v.current_odometer || 0),
          fipe_estimated_value: Number(v.fipe_estimated_value || 0),
          ipva_estimated_amount: Number(v.ipva_estimated_amount || 0),
          ipva_due_month: Number(v.ipva_due_month || 1),
          insurance_annual_amount: Number(v.insurance_annual_amount || 0),
          next_revision_km: v.next_revision_km !== null ? Number(v.next_revision_km) : null,
        })),
        records: recordsRes.rows.map(r => ({
          ...r,
          odometer_km: r.odometer_km !== null ? Number(r.odometer_km) : null,
          liters: r.liters !== null ? Number(r.liters) : null,
          price_per_liter: r.price_per_liter !== null ? Number(r.price_per_liter) : null,
          fuel_efficiency_kml: r.fuel_efficiency_kml !== null ? Number(r.fuel_efficiency_kml) : null,
          amount: Number(r.amount || 0),
          next_service_km: r.next_service_km !== null ? Number(r.next_service_km) : null,
        })),
      });
    } catch (error) {
      console.error('Erro ao carregar veículos da família:', error);
      return res.status(500).json({ error: 'Não foi possível carregar os veículos da família.' });
    }
  }
);

// 2. CADASTRAR NOVO VEÍCULO DA FAMÍLIA
router.post(
  '/',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const {
      nickname,
      vehicle_type = 'CAR',
      brand_model,
      manufacture_year,
      model_year,
      license_plate,
      fuel_type = 'FLEX',
      current_odometer = 0,
      fipe_estimated_value = 0,
      ipva_estimated_amount = 0,
      ipva_due_month = 1,
      insurance_provider,
      insurance_policy_number,
      insurance_renewal_date,
      insurance_annual_amount = 0,
      insurance_assistance_phone,
      next_revision_km,
      next_revision_date,
      notes,
    } = req.body ?? {};

    const cleanNickname = typeof nickname === 'string' ? nickname.trim() : '';
    const cleanBrandModel = typeof brand_model === 'string' ? brand_model.trim() : '';
    if (!cleanNickname || !cleanBrandModel) {
      return res.status(400).json({ error: 'Informe o apelido e a marca/modelo do veículo.' });
    }

    const safeType = ['CAR', 'MOTORCYCLE', 'SUV_PICKUP', 'OTHER'].includes(String(vehicle_type))
      ? String(vehicle_type)
      : 'CAR';
    const safeFuel = ['FLEX', 'GASOLINA', 'ETANOL', 'DIESEL', 'HIBRIDO', 'ELETRICO', 'GNV'].includes(String(fuel_type))
      ? String(fuel_type)
      : 'FLEX';
    const safeIpvaMonth = Math.min(12, Math.max(1, Number(ipva_due_month) || 1));

    try {
      const inserted = await pool.query(
        `INSERT INTO family_vehicles (
           family_id, nickname, vehicle_type, brand_model, manufacture_year, model_year,
           license_plate, fuel_type, current_odometer, fipe_estimated_value,
           ipva_estimated_amount, ipva_due_month, insurance_provider, insurance_policy_number,
           insurance_renewal_date, insurance_annual_amount, insurance_assistance_phone,
           next_revision_km, next_revision_date, notes
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING id, family_id, nickname, vehicle_type, brand_model, manufacture_year, model_year,
                   license_plate, fuel_type, current_odometer, fipe_estimated_value,
                   ipva_estimated_amount, ipva_due_month, insurance_provider, insurance_policy_number,
                   TO_CHAR(insurance_renewal_date, 'YYYY-MM-DD') AS insurance_renewal_date,
                   insurance_annual_amount, insurance_assistance_phone, next_revision_km,
                   TO_CHAR(next_revision_date, 'YYYY-MM-DD') AS next_revision_date,
                   status, notes`,
        [
          familyId,
          cleanNickname.slice(0, 100),
          safeType,
          cleanBrandModel.slice(0, 120),
          manufacture_year ? Number(manufacture_year) : null,
          model_year ? Number(model_year) : null,
          typeof license_plate === 'string' && license_plate.trim()
            ? license_plate.trim().toUpperCase().slice(0, 20)
            : null,
          safeFuel,
          Math.max(0, Math.round(Number(current_odometer) || 0)),
          Math.max(0, Number(fipe_estimated_value) || 0),
          Math.max(0, Number(ipva_estimated_amount) || 0),
          safeIpvaMonth,
          typeof insurance_provider === 'string' && insurance_provider.trim()
            ? insurance_provider.trim().slice(0, 120)
            : null,
          typeof insurance_policy_number === 'string' && insurance_policy_number.trim()
            ? insurance_policy_number.trim().slice(0, 80)
            : null,
          typeof insurance_renewal_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(insurance_renewal_date)
            ? insurance_renewal_date
            : null,
          Math.max(0, Number(insurance_annual_amount) || 0),
          typeof insurance_assistance_phone === 'string' && insurance_assistance_phone.trim()
            ? insurance_assistance_phone.trim().slice(0, 60)
            : null,
          next_revision_km ? Math.max(0, Math.round(Number(next_revision_km))) : null,
          typeof next_revision_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(next_revision_date)
            ? next_revision_date
            : null,
          typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 300) : null,
        ]
      );

      return res.status(201).json(inserted.rows[0]);
    } catch (error) {
      console.error('Erro ao cadastrar veículo:', error);
      return res.status(500).json({ error: 'Não foi possível cadastrar o veículo.' });
    }
  }
);

// 3. ATUALIZAR VEÍCULO DA FAMÍLIA
router.put(
  '/:id',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const vehicleId = req.params.id;
    const {
      nickname,
      vehicle_type,
      brand_model,
      manufacture_year,
      model_year,
      license_plate,
      fuel_type,
      current_odometer,
      fipe_estimated_value,
      ipva_estimated_amount,
      ipva_due_month,
      insurance_provider,
      insurance_policy_number,
      insurance_renewal_date,
      insurance_annual_amount,
      insurance_assistance_phone,
      next_revision_km,
      next_revision_date,
      status,
      notes,
    } = req.body ?? {};

    try {
      const existing = await pool.query(
        'SELECT * FROM family_vehicles WHERE id = $1 AND family_id = $2',
        [vehicleId, familyId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Veículo não encontrado.' });
      }
      const cur = existing.rows[0];

      const updated = await pool.query(
        `UPDATE family_vehicles
         SET nickname = $1,
             vehicle_type = $2,
             brand_model = $3,
             manufacture_year = $4,
             model_year = $5,
             license_plate = $6,
             fuel_type = $7,
             current_odometer = $8,
             fipe_estimated_value = $9,
             ipva_estimated_amount = $10,
             ipva_due_month = $11,
             insurance_provider = $12,
             insurance_policy_number = $13,
             insurance_renewal_date = $14,
             insurance_annual_amount = $15,
             insurance_assistance_phone = $16,
             next_revision_km = $17,
             next_revision_date = $18,
             status = $19,
             notes = $20,
             updated_at = NOW()
         WHERE id = $21 AND family_id = $22
         RETURNING id, family_id, nickname, vehicle_type, brand_model, manufacture_year, model_year,
                   license_plate, fuel_type, current_odometer, fipe_estimated_value,
                   ipva_estimated_amount, ipva_due_month, insurance_provider, insurance_policy_number,
                   TO_CHAR(insurance_renewal_date, 'YYYY-MM-DD') AS insurance_renewal_date,
                   insurance_annual_amount, insurance_assistance_phone, next_revision_km,
                   TO_CHAR(next_revision_date, 'YYYY-MM-DD') AS next_revision_date,
                   status, notes`,
        [
          typeof nickname === 'string' && nickname.trim() ? nickname.trim().slice(0, 100) : cur.nickname,
          typeof vehicle_type === 'string' && ['CAR', 'MOTORCYCLE', 'SUV_PICKUP', 'OTHER'].includes(vehicle_type)
            ? vehicle_type
            : cur.vehicle_type,
          typeof brand_model === 'string' && brand_model.trim() ? brand_model.trim().slice(0, 120) : cur.brand_model,
          manufacture_year !== undefined ? (manufacture_year ? Number(manufacture_year) : null) : cur.manufacture_year,
          model_year !== undefined ? (model_year ? Number(model_year) : null) : cur.model_year,
          license_plate !== undefined
            ? typeof license_plate === 'string' && license_plate.trim()
              ? license_plate.trim().toUpperCase().slice(0, 20)
              : null
            : cur.license_plate,
          typeof fuel_type === 'string' ? fuel_type : cur.fuel_type,
          current_odometer !== undefined
            ? Math.max(0, Math.round(Number(current_odometer) || 0))
            : Number(cur.current_odometer || 0),
          fipe_estimated_value !== undefined
            ? Math.max(0, Number(fipe_estimated_value) || 0)
            : Number(cur.fipe_estimated_value || 0),
          ipva_estimated_amount !== undefined
            ? Math.max(0, Number(ipva_estimated_amount) || 0)
            : Number(cur.ipva_estimated_amount || 0),
          ipva_due_month !== undefined
            ? Math.min(12, Math.max(1, Number(ipva_due_month) || 1))
            : Number(cur.ipva_due_month || 1),
          insurance_provider !== undefined
            ? typeof insurance_provider === 'string' && insurance_provider.trim()
              ? insurance_provider.trim().slice(0, 120)
              : null
            : cur.insurance_provider,
          insurance_policy_number !== undefined
            ? typeof insurance_policy_number === 'string' && insurance_policy_number.trim()
              ? insurance_policy_number.trim().slice(0, 80)
              : null
            : cur.insurance_policy_number,
          insurance_renewal_date !== undefined
            ? typeof insurance_renewal_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(insurance_renewal_date)
              ? insurance_renewal_date
              : null
            : cur.insurance_renewal_date,
          insurance_annual_amount !== undefined
            ? Math.max(0, Number(insurance_annual_amount) || 0)
            : Number(cur.insurance_annual_amount || 0),
          insurance_assistance_phone !== undefined
            ? typeof insurance_assistance_phone === 'string' && insurance_assistance_phone.trim()
              ? insurance_assistance_phone.trim().slice(0, 60)
              : null
            : cur.insurance_assistance_phone,
          next_revision_km !== undefined
            ? next_revision_km
              ? Math.max(0, Math.round(Number(next_revision_km)))
              : null
            : cur.next_revision_km,
          next_revision_date !== undefined
            ? typeof next_revision_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(next_revision_date)
              ? next_revision_date
              : null
            : cur.next_revision_date,
          typeof status === 'string' && ['ACTIVE', 'SOLD', 'INACTIVE'].includes(status) ? status : cur.status,
          notes !== undefined ? (typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 300) : null) : cur.notes,
          vehicleId,
          familyId,
        ]
      );

      return res.json(updated.rows[0]);
    } catch (error) {
      console.error('Erro ao atualizar veículo:', error);
      return res.status(500).json({ error: 'Não foi possível atualizar o veículo.' });
    }
  }
);

// 4. EXCLUIR VEÍCULO
router.delete(
  '/:id',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    try {
      await pool.query('DELETE FROM family_vehicles WHERE id = $1 AND family_id = $2', [
        req.params.id,
        familyId,
      ]);
      return res.json({ message: 'Veículo removido com sucesso.' });
    } catch (error) {
      console.error('Erro ao remover veículo:', error);
      return res.status(500).json({ error: 'Não foi possível remover o veículo.' });
    }
  }
);

// 5. REGISTRAR ABASTECIMENTO, MANUTENÇÃO, IPVA OU SEGURO (COM CÁLCULO DE KM/L E INTEGRAÇÃO FINANCEIRA)
router.post(
  '/:id/records',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const vehicleId = req.params.id;
    const {
      record_type = 'FUEL',
      title,
      service_category = 'Abastecimento',
      record_date,
      odometer_km,
      liters,
      price_per_liter,
      amount,
      provider_name,
      next_service_km,
      next_service_date,
      notes,
      launch_in_financial = false,
      payment_target = 'CARD',
      account_id,
      credit_card_id,
      category_id,
      financial_status = 'PAID',
    } = req.body ?? {};

    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    const numAmount = Number(amount);
    if (!cleanTitle || !Number.isFinite(numAmount) || numAmount < 0) {
      return res.status(400).json({ error: 'Informe a descrição e o valor válido do registro.' });
    }

    const safeRecordType = ['FUEL', 'MAINTENANCE', 'DOCUMENT_TAX', 'INSURANCE', 'OTHER'].includes(String(record_type))
      ? String(record_type)
      : 'FUEL';
    const safeDate =
      typeof record_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record_date)
        ? record_date
        : new Date().toISOString().slice(0, 10);

    const parsedOdometer =
      odometer_km !== undefined && odometer_km !== null && odometer_km !== '' && Number(odometer_km) > 0
        ? Math.round(Number(odometer_km))
        : null;
    const parsedLiters =
      liters !== undefined && liters !== null && liters !== '' && Number(liters) > 0
        ? Number(Number(liters).toFixed(3))
        : null;
    const parsedPricePerLiter =
      price_per_liter !== undefined && price_per_liter !== null && price_per_liter !== '' && Number(price_per_liter) > 0
        ? Number(Number(price_per_liter).toFixed(3))
        : parsedLiters && parsedLiters > 0
        ? Number((numAmount / parsedLiters).toFixed(3))
        : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const vehicleRes = await client.query(
        'SELECT * FROM family_vehicles WHERE id = $1 AND family_id = $2 FOR UPDATE',
        [vehicleId, familyId]
      );
      if (vehicleRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Veículo não encontrado.' });
      }
      const vehicle = vehicleRes.rows[0];

      // Calcula consumo médio (km/L) se for abastecimento e houver odômetro anterior
      let calculatedEfficiencyKml: number | null = null;
      if (safeRecordType === 'FUEL' && parsedOdometer && parsedLiters && parsedLiters > 0) {
        const prevFuelRes = await client.query(
          `SELECT odometer_km
           FROM vehicle_records
           WHERE vehicle_id = $1 AND family_id = $2
             AND odometer_km IS NOT NULL AND odometer_km < $3
           ORDER BY odometer_km DESC
           LIMIT 1`,
          [vehicleId, familyId, parsedOdometer]
        );
        const baselineKm =
          prevFuelRes.rows[0]?.odometer_km !== undefined
            ? Number(prevFuelRes.rows[0].odometer_km)
            : Number(vehicle.current_odometer || 0) > 0 && Number(vehicle.current_odometer) < parsedOdometer
            ? Number(vehicle.current_odometer)
            : null;

        if (baselineKm && parsedOdometer > baselineKm) {
          const distanceKm = parsedOdometer - baselineKm;
          if (distanceKm > 0 && distanceKm <= 3000) {
            calculatedEfficiencyKml = Number((distanceKm / parsedLiters).toFixed(2));
          }
        }
      }

      // Se marcado para lançar no financeiro, cria a transação
      let createdTransactionId: string | null = null;
      if (launch_in_financial && numAmount > 0) {
        let resolvedCategoryId = category_id ? String(category_id) : null;
        if (!resolvedCategoryId) {
          const catRes = await client.query(
            `SELECT id FROM categories
             WHERE family_id::text = $1 AND flow_type = 'EXPENSE'
             ORDER BY CASE WHEN LOWER(name) LIKE '%veíc%' OR LOWER(name) LIKE '%transp%' OR LOWER(name) LIKE '%auto%' OR LOWER(name) LIKE '%combust%' THEN 0 ELSE 1 END, id ASC
             LIMIT 1`,
            [familyId]
          );
          resolvedCategoryId = catRes.rows[0]?.id ? String(catRes.rows[0].id) : null;
        }

        const isCard = payment_target === 'CARD';
        const txStatus = isCard ? 'PENDING' : financial_status === 'PAID' ? 'PAID' : 'PENDING';
        const txAccountId = !isCard && account_id ? String(account_id) : null;
        const txCardId = isCard && credit_card_id ? String(credit_card_id) : null;

        const txInsert = await client.query(
          `INSERT INTO transactions (
             family_id, account_id, credit_card_id, category_id, description,
             amount, paid_amount, transaction_date, due_date, payment_date,
             type, status, payment_method
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, 'EXPENSE', $10, $11)
           RETURNING id`,
          [
            familyId,
            txAccountId,
            txCardId,
            resolvedCategoryId,
            `[${vehicle.nickname}] ${cleanTitle}`,
            numAmount,
            txStatus === 'PAID' ? numAmount : null,
            safeDate,
            txStatus === 'PAID' ? safeDate : null,
            txStatus,
            isCard ? 'CARD' : 'PIX',
          ]
        );
        createdTransactionId = txInsert.rows[0]?.id ? String(txInsert.rows[0].id) : null;

        if (txStatus === 'PAID' && txAccountId) {
          await client.query(
            'UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND family_id = $3',
            [numAmount, txAccountId, familyId]
          );
        }
      }

      const parsedNextServiceKm =
        next_service_km !== undefined && next_service_km !== null && next_service_km !== '' && Number(next_service_km) > 0
          ? Math.round(Number(next_service_km))
          : null;
      const parsedNextServiceDate =
        typeof next_service_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(next_service_date)
          ? next_service_date
          : null;

      const recordInsert = await client.query(
        `INSERT INTO vehicle_records (
           family_id, vehicle_id, record_type, title, service_category,
           record_date, odometer_km, liters, price_per_liter, fuel_efficiency_kml,
           amount, provider_name, next_service_km, next_service_date,
           financial_transaction_id, notes
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id, family_id, vehicle_id, record_type, title, service_category,
                   TO_CHAR(record_date, 'YYYY-MM-DD') AS record_date,
                   odometer_km, liters, price_per_liter, fuel_efficiency_kml,
                   amount, provider_name, next_service_km,
                   TO_CHAR(next_service_date, 'YYYY-MM-DD') AS next_service_date,
                   financial_transaction_id, notes, created_at`,
        [
          familyId,
          vehicleId,
          safeRecordType,
          cleanTitle.slice(0, 140),
          typeof service_category === 'string' && service_category.trim()
            ? service_category.trim().slice(0, 60)
            : 'Abastecimento',
          safeDate,
          parsedOdometer,
          parsedLiters,
          parsedPricePerLiter,
          calculatedEfficiencyKml,
          numAmount,
          typeof provider_name === 'string' && provider_name.trim() ? provider_name.trim().slice(0, 120) : null,
          parsedNextServiceKm,
          parsedNextServiceDate,
          createdTransactionId,
          typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 300) : null,
        ]
      );

      // Atualiza odômetro atual do veículo e próxima revisão se aplicável
      const newOdometer =
        parsedOdometer && parsedOdometer > Number(vehicle.current_odometer || 0)
          ? parsedOdometer
          : Number(vehicle.current_odometer || 0);
      const updatedNextRevKm = parsedNextServiceKm ?? vehicle.next_revision_km;
      const updatedNextRevDate = parsedNextServiceDate ?? vehicle.next_revision_date;

      await client.query(
        `UPDATE family_vehicles
         SET current_odometer = $1,
             next_revision_km = $2,
             next_revision_date = $3,
             updated_at = NOW()
         WHERE id = $4 AND family_id = $5`,
        [newOdometer, updatedNextRevKm, updatedNextRevDate, vehicleId, familyId]
      );

      await client.query('COMMIT');
      return res.status(201).json({
        record: recordInsert.rows[0],
        calculated_efficiency_kml: calculatedEfficiencyKml,
        launched_in_financial: Boolean(createdTransactionId),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao registrar evento do veículo:', error);
      return res.status(500).json({ error: 'Não foi possível salvar o registro do veículo.' });
    } finally {
      client.release();
    }
  }
);

// 6. EXCLUIR REGISTRO DO HISTÓRICO DO VEÍCULO
router.delete(
  '/records/:recordId',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    try {
      await pool.query('DELETE FROM vehicle_records WHERE id = $1 AND family_id = $2', [
        req.params.recordId,
        familyId,
      ]);
      return res.json({ message: 'Registro do veículo excluído.' });
    } catch (error) {
      console.error('Erro ao excluir registro do veículo:', error);
      return res.status(500).json({ error: 'Não foi possível excluir o registro.' });
    }
  }
);

// 7. GERAR PARCELAS DE IPVA OU SEGURO NO FINANCEIRO EM 1 CLIQUE
router.post(
  '/:id/launch-annual-expense',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const vehicleId = req.params.id;
    const {
      expense_kind = 'IPVA', // 'IPVA' | 'INSURANCE'
      installments = 1,
      total_amount,
      first_due_date,
      payment_target = 'ACCOUNT',
      account_id,
      credit_card_id,
      category_id,
    } = req.body ?? {};

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const vehicleRes = await client.query(
        'SELECT * FROM family_vehicles WHERE id = $1 AND family_id = $2',
        [vehicleId, familyId]
      );
      if (vehicleRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Veículo não encontrado.' });
      }
      const vehicle = vehicleRes.rows[0];

      const fallbackTotal =
        expense_kind === 'INSURANCE'
          ? Number(vehicle.insurance_annual_amount || 0)
          : Number(vehicle.ipva_estimated_amount || 0);
      const finalTotal = Number(total_amount) > 0 ? Number(total_amount) : fallbackTotal;

      if (finalTotal <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Informe um valor total maior que zero para gerar as parcelas.' });
      }

      const count = Math.min(12, Math.max(1, Math.round(Number(installments) || 1)));
      const installmentValue = Number((finalTotal / count).toFixed(2));

      let resolvedCategoryId = category_id ? String(category_id) : null;
      if (!resolvedCategoryId) {
        const catRes = await client.query(
          `SELECT id FROM categories
           WHERE family_id::text = $1 AND flow_type = 'EXPENSE'
           ORDER BY id ASC LIMIT 1`,
          [familyId]
        );
        resolvedCategoryId = catRes.rows[0]?.id ? String(catRes.rows[0].id) : null;
      }

      const baseDate =
        typeof first_due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(first_due_date)
          ? first_due_date
          : new Date().toISOString().slice(0, 10);

      const labelPrefix =
        expense_kind === 'INSURANCE'
          ? `Seguro Auto - ${vehicle.nickname}`
          : `IPVA & Licenciamento - ${vehicle.nickname}`;

      for (let i = 0; i < count; i++) {
        const dueDate = addMonthsToDateStr(baseDate, i);
        const description = count > 1 ? `${labelPrefix} (${i + 1}/${count})` : labelPrefix;

        await client.query(
          `INSERT INTO transactions (
             family_id, account_id, credit_card_id, category_id, description,
             amount, transaction_date, due_date, type, status, payment_method
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'EXPENSE', 'PENDING', $8)`,
          [
            familyId,
            payment_target === 'ACCOUNT' && account_id ? account_id : null,
            payment_target === 'CARD' && credit_card_id ? credit_card_id : null,
            resolvedCategoryId,
            description,
            installmentValue,
            dueDate,
            payment_target === 'CARD' ? 'CARD' : 'BOLETO',
          ]
        );
      }

      await client.query('COMMIT');
      return res.json({
        message: `${count} parcela(s) de ${labelPrefix} enviada(s) para Contas a Pagar!`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao gerar parcelas anuais do veículo:', error);
      return res.status(500).json({ error: 'Não foi possível gerar os lançamentos no financeiro.' });
    } finally {
      client.release();
    }
  }
);

export default router;
