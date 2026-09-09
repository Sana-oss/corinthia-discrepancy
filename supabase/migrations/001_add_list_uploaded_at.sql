alter table daily_reports add column if not exists list_uploaded_at timestamptz;

create or replace function stamp_list_uploaded_at()
returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.list_uploaded_at is not null then
      NEW.list_uploaded_at := now();
    end if;
  elsif TG_OP = 'UPDATE' then
    if NEW.list_uploaded_at is distinct from OLD.list_uploaded_at then
      NEW.list_uploaded_at := now();
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_stamp_list_uploaded_at on daily_reports;
create trigger trg_stamp_list_uploaded_at
before insert or update on daily_reports
for each row execute function stamp_list_uploaded_at();
