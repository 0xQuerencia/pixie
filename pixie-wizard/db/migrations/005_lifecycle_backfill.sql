-- Lifecycle was added after hosted_programs already existed. Preserve the
-- effective admin status for rows created before this migration; new rows use
-- the lifecycle default and are not present when this migration runs.
update hosted_programs
set lifecycle = case status
  when 'active' then 'active'
  when 'suspended' then 'paused'
  when 'archived' then 'archived'
  else lifecycle
end
where lifecycle = 'draft' and status in ('active', 'suspended', 'archived');
