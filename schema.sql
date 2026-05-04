-- ============================================================
-- CalBot v2 — Supabase Schema
-- แพ็กเกจ: Free | Premium เท่านั้น (ไม่มี Pro/B2B)
-- รันทั้งหมดใน Supabase SQL Editor
-- ============================================================

-- ตาราง users
create table if not exists users (
  id                    uuid default gen_random_uuid() primary key,
  line_user_id          text unique not null,
  display_name          text,
  -- แพ็กเกจ
  plan                  text default 'free',        -- free | premium
  plan_expires_at       timestamptz,
  -- เป้าหมายส่วนตัว
  goal                  text default 'maintain',    -- lose | gain | maintain
  target_calories       int  default 1300,
  weight_kg             numeric(5,1),
  height_cm             int,
  age                   int,
  gender                text,                       -- male | female
  -- IF settings
  if_mode               boolean default false,
  if_hours              int     default 16,
  if_start_time         timestamptz,
  -- Push settings (Premium)
  weekly_summary_time   text    default '08:00',
  weekly_summary_sent   text,                       -- YYYY-MM-DD
  -- Streak
  streak_count          int  default 0,
  streak_last_date      text,
  -- Onboarding
  onboarding_done       boolean default false,
  created_at            timestamptz default now()
);

-- ตาราง food_logs (บันทึกอาหาร)
create table if not exists food_logs (
  id               uuid default gen_random_uuid() primary key,
  user_id          text not null references users(line_user_id) on delete cascade,
  log_date         text not null,                  -- YYYY-MM-DD
  meal_type        text default 'other',           -- breakfast|lunch|dinner|snack|other
  food_name        text not null,
  amount_desc      text,
  -- แคลอรี่และ macros
  calories         int  not null default 0,
  carbs_g          numeric(6,1) default 0,
  protein_g        numeric(6,1) default 0,
  fat_total_g      numeric(6,1) default 0,
  -- ไขมันแยกประเภท
  fat_saturated_g  numeric(6,1) default 0,         -- ไขมันเลว
  fat_unsaturated_g numeric(6,1) default 0,        -- ไขมันดี
  fat_omega3_g     numeric(6,1) default 0,         -- Omega-3
  fat_trans_g      numeric(6,1) default 0,         -- Trans fat
  -- น้ำ
  is_water         boolean default false,
  water_ml         int,
  -- metadata
  is_estimate      boolean default false,
  source           text default 'text',            -- text | image | quick
  created_at       timestamptz default now()
);

-- ตาราง exercise_logs (บันทึกออกกำลังกาย)
create table if not exists exercise_logs (
  id               uuid default gen_random_uuid() primary key,
  user_id          text not null references users(line_user_id) on delete cascade,
  log_date         text not null,                  -- YYYY-MM-DD
  exercise_name    text not null,
  duration_min     int  not null,
  calories_burned  int  not null,
  intensity        text default 'moderate',        -- low | moderate | high
  notes            text,
  created_at       timestamptz default now()
);

-- ตาราง user_tokens (สำหรับ link ปฏิทิน web view ในอนาคต)
create table if not exists user_tokens (
  id           uuid default gen_random_uuid() primary key,
  line_user_id text unique not null,
  token        text unique not null,
  created_at   timestamptz default now()
);

-- ── Index ──────────────────────────────────────────────────
create index if not exists idx_food_logs_user_date
  on food_logs(user_id, log_date);

create index if not exists idx_exercise_logs_user_date
  on exercise_logs(user_id, log_date);

create index if not exists idx_users_line_user_id
  on users(line_user_id);

-- ── View: สรุปรายวัน ───────────────────────────────────────
create or replace view daily_summary as
select
  f.user_id,
  f.log_date,
  coalesce(sum(case when not f.is_water then f.calories end), 0)          as food_calories,
  coalesce(sum(case when not f.is_water then f.carbs_g end), 0)            as total_carbs,
  coalesce(sum(case when not f.is_water then f.protein_g end), 0)          as total_protein,
  coalesce(sum(case when not f.is_water then f.fat_total_g end), 0)        as total_fat,
  coalesce(sum(case when not f.is_water then f.fat_saturated_g end), 0)    as total_sat_fat,
  coalesce(sum(case when not f.is_water then f.fat_omega3_g end), 0)       as total_omega3,
  coalesce(sum(case when f.is_water then f.water_ml end), 0)               as total_water_ml,
  count(case when not f.is_water then 1 end)                               as meal_count,
  coalesce((
    select sum(e.calories_burned)
    from exercise_logs e
    where e.user_id = f.user_id and e.log_date = f.log_date
  ), 0) as exercise_calories
from food_logs f
group by f.user_id, f.log_date;
