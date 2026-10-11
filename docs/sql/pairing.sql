-- ============================================================================
-- 空间模型配对 · 后端全量 SQL（app: wbapp_aEuqo04CtucnCnaaQ8i9oU）
-- ----------------------------------------------------------------------------
-- 用途：让设备免登录可用、用 6 位配对码加入空间、之后持续双向同步。
-- 设计说明见 plans/quantum-forging-turing-Ia4Mx06N.md
--
-- ⚠️ 执行方式：数据库工具的 exec_sql **单次只支持一条语句**（预备语句限制），
--    所以下面按语句逐条执行，不要整段贴。
-- ⚠️ Postgres 新建函数默认把 EXECUTE 给了 PUBLIC，**必须逐个 revoke 再精确 grant**，
--    否则匿名角色能调内部函数（dev_resolve / dev_new_token）。
-- ⚠️ 本环境只装了 plpgsql、没有 pgcrypto → 令牌生成用内建 gen_random_uuid()，
--    哈希用内建 md5()。
--
-- 关键设计：**复用 owner_id 承载空间 ID**，因此 categories / time_entries 两表
-- 一列都不用改，两个关键索引原样成立：
--   categories  唯一 (owner_id, name)                → 空间内分类不重名
--   time_entries 部分唯一 (owner_id) WHERE end_time IS NULL → 空间内同时只有一条进行中
-- ============================================================================


-- ─────────────────────────── 一、表 ───────────────────────────

create table if not exists public.spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default '我的时间线',
  legacy_owner_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  token_hash text not null unique,
  name text not null default '设备',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create table if not exists public.pair_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  space_id uuid not null references public.spaces(id) on delete cascade,
  device_name text not null default '',
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.pair_throttle (
  bucket timestamptz primary key,
  attempts int not null default 0
);

create index if not exists devices_space_idx on public.devices(space_id);
create index if not exists pair_codes_space_idx on public.pair_codes(space_id);
-- 未使用的码必须唯一，否则可能撞码；已被消费的码不占用唯一性
create unique index if not exists pair_codes_active_code_uq on public.pair_codes(code) where consumed_at is null;

alter table public.spaces       enable row level security;
alter table public.devices      enable row level security;
alter table public.pair_codes   enable row level security;
alter table public.pair_throttle enable row level security;

-- 四张表不给客户端任何直接权限：读写一律经过 SECURITY DEFINER 函数
revoke all on public.spaces, public.devices, public.pair_codes, public.pair_throttle from anon, authenticated;


-- ─────────────────────────── 二、函数 ───────────────────────────

-- 生成设备令牌：64 位 hex（两个 uuid 去掉横线拼起来 ≈ 256 bit）
create or replace function public.dev_new_token()
returns text language sql security definer set search_path = public, pg_temp as $$
  select replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')
$$;

-- 内部：令牌 → 空间 ID。**不给客户端授权**，只被其他 SECURITY DEFINER 函数调用。
create or replace function public.dev_resolve(p_token text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  select space_id into v_space from public.devices
   where token_hash = md5(p_token) and revoked_at is null;
  if v_space is null then return null; end if;
  update public.devices set last_seen_at = now() where token_hash = md5(p_token);
  return v_space;
end $$;

-- 全新用户建空间（微信输入法的"第一台设备"）
create or replace function public.space_create(p_device_name text default '')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid; v_token text; v_dev uuid;
begin
  v_token := public.dev_new_token();
  insert into public.spaces(name) values ('我的时间线') returning id into v_space;
  insert into public.devices(space_id, token_hash, name)
    values (v_space, md5(v_token), coalesce(nullif(trim(p_device_name),''), '第一台设备'))
    returning id into v_dev;
  return jsonb_build_object('ok', true, 'token', v_token, 'device_id', v_dev::text, 'space_id', v_space::text);
end $$;

-- 一次性迁移：把当前账号名下的数据认领进一个空间，并发首张令牌。
-- 幂等：重复调用只会再发一张新令牌，不会重复搬数据。
create or replace function public.space_claim(p_device_name text default '')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid text; v_space uuid; v_token text; v_dev uuid; v_cat int; v_ent int;
begin
  v_uid := auth.uid();
  if v_uid is null or v_uid = '' then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  select id into v_space from public.spaces where legacy_owner_id = v_uid limit 1;
  if v_space is null then
    insert into public.spaces(name, legacy_owner_id) values ('我的时间线', v_uid) returning id into v_space;
  end if;
  update public.categories   set owner_id = v_space::text where owner_id = v_uid;
  get diagnostics v_cat = row_count;
  update public.time_entries set owner_id = v_space::text where owner_id = v_uid;
  get diagnostics v_ent = row_count;
  v_token := public.dev_new_token();
  insert into public.devices(space_id, token_hash, name)
    values (v_space, md5(v_token), coalesce(nullif(trim(p_device_name),''), '电脑'))
    returning id into v_dev;
  return jsonb_build_object('ok', true, 'token', v_token, 'device_id', v_dev::text, 'space_id', v_space::text,
    'migrated', jsonb_build_object('categories', v_cat, 'entries', v_ent));
end $$;

-- 生成 6 位配对码（作废该空间旧码）。码 5 分钟有效、一次性。
create or replace function public.pair_create_code(p_token text, p_device_name text default '')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid; v_code text; i int;
begin
  v_space := public.dev_resolve(p_token);
  if v_space is null then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  update public.pair_codes set consumed_at = now() where space_id = v_space and consumed_at is null;
  for i in 1..20 loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into public.pair_codes(code, space_id, device_name, expires_at)
        values (v_code, v_space, coalesce(p_device_name,''), now() + interval '300 seconds');
      return jsonb_build_object('ok', true, 'code', v_code, 'ttl_sec', 300);
    exception when unique_violation then
      null;   -- 撞码（极少），换一个再来
    end;
  end loop;
  return jsonb_build_object('ok', false, 'error', 'code_gen_failed');
end $$;

-- 输码换令牌（新设备，无需登录）
create or replace function public.pair_redeem(p_code text, p_device_name text default '')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.pair_codes; v_token text; v_dev uuid; v_n int;
begin
  -- 格式不对直接拒，且**不消耗限流额度**（格式检查是免费的）
  if p_code is null or p_code !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  -- 全局限流：错码无法归属到具体行，按码计次做不到，只能全局每分钟桶
  insert into public.pair_throttle(bucket, attempts) values (date_trunc('minute', now()), 1)
    on conflict (bucket) do update set attempts = public.pair_throttle.attempts + 1
    returning attempts into v_n;
  if v_n > 30 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  delete from public.pair_throttle where bucket < now() - interval '1 hour';

  select * into v_row from public.pair_codes
    where code = p_code and consumed_at is null limit 1;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if v_row.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'expired'); end if;

  update public.pair_codes set consumed_at = now() where id = v_row.id;
  v_token := public.dev_new_token();
  insert into public.devices(space_id, token_hash, name)
    values (v_row.space_id, md5(v_token), coalesce(nullif(trim(p_device_name),''), '手机'))
    returning id into v_dev;
  return jsonb_build_object('ok', true, 'token', v_token, 'device_id', v_dev::text, 'space_id', v_row.space_id::text);
end $$;

create or replace function public.pair_list_devices(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid; v_self uuid;
begin
  v_space := public.dev_resolve(p_token);
  if v_space is null then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  select id into v_self from public.devices where token_hash = md5(p_token);
  return jsonb_build_object('ok', true, 'self', v_self::text,
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'created_at', created_at,
        'last_seen_at', last_seen_at, 'revoked', revoked_at is not null) order by created_at)
      from public.devices where space_id = v_space), '[]'::jsonb));
end $$;

create or replace function public.pair_revoke_device(p_token text, p_device_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid; v_self uuid; v_n int;
begin
  v_space := public.dev_resolve(p_token);
  if v_space is null then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  select id into v_self from public.devices where token_hash = md5(p_token);
  -- 不许撤销自己，否则会把自己锁在外面
  if p_device_id = v_self then return jsonb_build_object('ok', false, 'error', 'cannot_revoke_self'); end if;
  update public.devices set revoked_at = now()
   where id = p_device_id and space_id = v_space and revoked_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n > 0);
end $$;

-- 拉取：**剔除 owner_id**，不泄露内部分配
create or replace function public.dev_pull(p_token text, p_since timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid; v_key text;
begin
  v_space := public.dev_resolve(p_token);
  if v_space is null then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  v_key := v_space::text;
  return jsonb_build_object('ok', true, 'server_time', now(),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'color', color,
        'sort_order', sort_order, 'created_at', created_at) order by sort_order nulls last, created_at)
      from public.categories where owner_id = v_key), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'category_id', category_id,
        'start_time', start_time, 'end_time', end_time, 'duration_sec', duration_sec,
        'created_at', created_at, 'updated_at', updated_at) order by start_time desc)
      from public.time_entries
      where owner_id = v_key
        and (p_since is null or coalesce(updated_at, created_at, start_time) >= p_since)), '[]'::jsonb));
end $$;

-- 原子切换：关旧 + 开新在同一次调用里。
-- plpgsql 的 exception 块会回滚块内改动 → 开新失败时关旧也一并撤销，不会半关半开。
-- duration_sec 由**服务端**按两个时间戳算，顺带免疫客户端时钟偏移。
create or replace function public.dev_switch(p_token text, p_close jsonb, p_open jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid; v_key text; v_end timestamptz; v_old int := 0; v_new public.time_entries; v_cat uuid; v_title text;
begin
  v_space := public.dev_resolve(p_token);
  if v_space is null then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  v_key := v_space::text;
  v_end := coalesce(nullif(p_open->>'start_time','')::timestamptz, now());
  v_title := coalesce(p_open->>'title','');
  begin
    if p_close is not null and coalesce(p_close->>'id','') <> '' then
      update public.time_entries
         set end_time = v_end,
             duration_sec = greatest(1, floor(extract(epoch from (v_end - start_time)))::int),
             updated_at = v_end
       where id = (p_close->>'id')::uuid and owner_id = v_key and end_time is null;
      get diagnostics v_old = row_count;
    end if;
    if coalesce(p_open->>'category_id','') = '' or p_open->>'category_id' is null then
      v_cat := null;
    else
      v_cat := (p_open->>'category_id')::uuid;
      if not exists (select 1 from public.categories where id = v_cat and owner_id = v_key) then
        v_cat := null;   -- 分类已被删则落成未分类，不报错
      end if;
    end if;
    insert into public.time_entries(owner_id, title, category_id, start_time, created_at, updated_at)
    values (v_key, v_title, v_cat, v_end, now(), now())
    returning * into v_new;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'running_conflict');
  end;
  return jsonb_build_object('ok', true, 'closed', v_old,
    'entry', jsonb_build_object('id', v_new.id::text, 'start_time', v_new.start_time,
      'end_time', v_new.end_time, 'category_id', v_new.category_id, 'duration_sec', v_new.duration_sec));
end $$;

-- 所有写入都带 `where owner_id = v_key`：猜到别人的 uuid 也改不动别人的数据
create or replace function public.dev_put_category(p_token text, p_cat jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid; v_key text; v_id uuid; v_row public.categories;
begin
  v_space := public.dev_resolve(p_token);
  if v_space is null then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  v_key := v_space::text;
  v_id := coalesce(nullif(p_cat->>'id','')::uuid, gen_random_uuid());
  begin
    insert into public.categories(id, owner_id, name, color, sort_order, created_at)
    values (v_id, v_key, coalesce(p_cat->>'name',''), coalesce(p_cat->>'color','#8a91a3'),
            coalesce((p_cat->>'sort_order')::int, 0),
            coalesce(nullif(p_cat->>'created_at','')::timestamptz, now()))
    on conflict (id) do update
      set name = excluded.name, color = excluded.color, sort_order = excluded.sort_order
      where public.categories.owner_id = v_key
    returning * into v_row;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'duplicate_name');
  end;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  return jsonb_build_object('ok', true, 'id', v_row.id::text, 'name', v_row.name);
end $$;

create or replace function public.dev_put_entry(p_token text, p_entry jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid; v_key text; v_id uuid; v_cat uuid; v_row public.time_entries;
begin
  v_space := public.dev_resolve(p_token);
  if v_space is null then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  v_key := v_space::text;
  v_id := coalesce(nullif(p_entry->>'id','')::uuid, gen_random_uuid());
  v_cat := nullif(p_entry->>'category_id','')::uuid;
  if v_cat is not null and not exists
     (select 1 from public.categories where id = v_cat and owner_id = v_key) then
    v_cat := null;
  end if;
  begin
    insert into public.time_entries(id, owner_id, title, category_id, start_time, end_time,
                                    duration_sec, created_at, updated_at)
    values (v_id, v_key, coalesce(p_entry->>'title',''), v_cat,
            coalesce(nullif(p_entry->>'start_time','')::timestamptz, now()),
            nullif(p_entry->>'end_time','')::timestamptz,
            nullif(p_entry->>'duration_sec','')::int,
            coalesce(nullif(p_entry->>'created_at','')::timestamptz, now()),
            coalesce(nullif(p_entry->>'updated_at','')::timestamptz, now()))
    on conflict (id) do update
      set title = excluded.title, category_id = excluded.category_id,
          start_time = excluded.start_time, end_time = excluded.end_time,
          duration_sec = excluded.duration_sec, updated_at = excluded.updated_at
      where public.time_entries.owner_id = v_key
    returning * into v_row;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'running_conflict');
  end;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  return jsonb_build_object('ok', true, 'id', v_row.id::text);
end $$;

create or replace function public.dev_delete_entry(p_token text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid; v_n int;
begin
  v_space := public.dev_resolve(p_token);
  if v_space is null then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  delete from public.time_entries where id = p_id and owner_id = v_space::text;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_n);
end $$;

create or replace function public.dev_delete_category(p_token text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_space uuid; v_n int;
begin
  v_space := public.dev_resolve(p_token);
  if v_space is null then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  delete from public.categories where id = p_id and owner_id = v_space::text;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_n);
end $$;

create or replace function public.dev_unpair(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  update public.devices set revoked_at = now() where token_hash = md5(p_token) and revoked_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n > 0);
end $$;


-- ─────────────────────────── 三、授权 ───────────────────────────
-- ⚠️ 必须逐个 revoke from public，否则匿名角色能调内部函数

revoke all on function public.dev_resolve(text), public.dev_new_token() from public;
revoke all on function public.space_create(text), public.space_claim(text) from public;
revoke all on function public.pair_create_code(text,text), public.pair_redeem(text,text),
                          public.pair_list_devices(text), public.pair_revoke_device(text,uuid) from public;
revoke all on function public.dev_pull(text,timestamptz), public.dev_switch(text,jsonb,jsonb),
                          public.dev_put_entry(text,jsonb), public.dev_put_category(text,jsonb),
                          public.dev_delete_entry(text,uuid), public.dev_delete_category(text,uuid),
                          public.dev_unpair(text) from public;

grant execute on function public.space_create(text) to anon, authenticated;
-- space_claim 靠账号身份认领数据，**只给 authenticated**
grant execute on function public.space_claim(text) to authenticated;
grant execute on function public.pair_create_code(text,text), public.pair_list_devices(text),
                          public.pair_revoke_device(text,uuid) to anon, authenticated;
grant execute on function public.pair_redeem(text,text) to anon, authenticated;
grant execute on function public.dev_pull(text,timestamptz), public.dev_switch(text,jsonb,jsonb) to anon, authenticated;
grant execute on function public.dev_put_entry(text,jsonb), public.dev_put_category(text,jsonb) to anon, authenticated;
grant execute on function public.dev_delete_entry(text,uuid), public.dev_delete_category(text,uuid),
                          public.dev_unpair(text) to anon, authenticated;

-- dev_resolve / dev_new_token **不授权给任何客户端角色**（只被上面这些 SECURITY DEFINER 函数内部调用）


-- ─────────────────────────── 四、一次性迁移 ───────────────────────────
-- 把当前账号名下的数据认领进空间。需在**还持有账号会话**的客户端上调用：
--   rpc('space_claim', { p_device_name: '我的电脑' })   → 返回 token
-- 之后全产品不再需要邮箱登录。
