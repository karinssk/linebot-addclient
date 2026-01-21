module.exports = {
    apps: [{
      name: 'add-client-server',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 4003
      },
      log_file: '/var/log/pm2/addclient-mobile-server.log',
      out_file: '/var/log/pm2/addclient-mobile-server.log',
      error_file: '/var/log/pm2/addclient-mobile-server-error.log',
      merge_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_restarts: 5,
      min_uptime: '10s',
      restart_delay: 4000,
      cron_restart: '0 2 * * *' // Restart daily at 2 AM
    }]
  };
  