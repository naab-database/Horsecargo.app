-- =====================================================================
--  HORSE CARGO — seed data (run after schema.sql)
--  Rates below are PLACEHOLDERS — set the real floor rates in the app
--  under "Rate card" before going live (Blueprint open decision #5).
-- =====================================================================
insert into public.branches(code, name, country, currency, phone, address) values
 ('DXB','Dubai','UAE','AED','+971 50 608 3531','Al Badri Building, Floor 2, Office S201, Baniyas Square, Deira'),
 ('DAR','Dar es Salaam','Tanzania','TZS','+255 778 222 251','Rufiji St & Swahili St, Kariakoo'),
 ('MWZ','Mwanza','Tanzania','TZS','+255 797 000 254','Mwanza')
on conflict (code) do nothing;

insert into public.settings(id) values (1) on conflict (id) do nothing;

insert into public.cargo_categories(name, name_sw, description, sea_rate_cbm, air_rate_kg, min_charge_sea, min_charge_air, permit_note, restricted) values
 ('General goods',       'Bidhaa za kawaida',      'Household & mixed general cargo',        180, 6.0,  30, 20, null, false),
 ('Electronics',         'Vifaa vya kielektroniki','Phones, TVs, laptops, accessories',      250, 8.0,  50, 30, 'TCRA type approval for telecom devices', false),
 ('Clothing & textiles', 'Nguo na vitambaa',       'Garments, shoes, fabrics',               190, 6.5,  30, 20, null, false),
 ('Spare parts',         'Vipuri',                 'Vehicle & machinery spare parts',        200, 6.5,  40, 25, null, false),
 ('Furniture',           'Samani',                 'Furniture & fittings',                   170, 5.5,  40, 25, null, false),
 ('Cosmetics',           'Vipodozi',               'Cosmetics & personal care',              220, 7.5,  40, 25, 'TMDA / TBS permit required', false),
 ('Food products',       'Vyakula',                'Packaged & dry food',                    200, 7.0,  40, 25, 'TBS / TMDA permit required', false),
 ('Reserved items (TASAC)','Bidhaa maalum (TASAC)','Arms, mineral concentrates, mining chemicals, trophies, live animals — GN 184/2025', 0, 0, 0, 0, 'Handled by TASAC only — do not book', true)
on conflict (name) do nothing;
