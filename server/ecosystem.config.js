module.exports = {
  apps: [{
    name: 'travel-aa',
    script: './app.js',
    instances: 1,          // 1核1G用1个实例即可
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    // 日志配置
    log_file: './logs/app.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // 自动重启
    autorestart: true,
    watch: false,
    max_restarts: 10
  }]
};
