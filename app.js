var colyseus = require('colyseus')
  , ServerIO = require('./server')
  , Connection = require('./connection')
  , bodyParser = require("body-parser")
  , http = require('http')
  , express = require('express')
  , port = process.env.PORT || 2657
  , app = express();

var server = http.createServer(app)
  , gameServer = new colyseus.Server({ server: server })

gameServer.register('Backgammon', ServerIO)

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());


app.get('/info/:session', function (request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  var req = request.params
  let ret = {};
  Connection.query('SELECT * FROM `users` LEFT JOIN `wallets` ON `users`.`token` = `wallets`.`token` where `users`.`token`=? LIMIT 1', [req.session])
    .then(results => {
      if (results[0] != null) {
        ret = {
          result: 'ok',
          data: {
            id: results[0].userId,
            name: results[0].username,
            balance: results[0].balance,
            level: 1
          }
        };
        Connection.query('SELECT * FROM `backgammon_setting` LIMIT 1')
          .then(results => {
            ret.setting = results[0];
            response.send(ret)
          });
      } else {
        ret.result = 'no';
        Connection.query('SELECT * FROM `backgammon_setting` LIMIT 1')
          .then(results => {
            ret.setting = results[0];
            response.send(ret)
          });
      }
    }, e => {
      ret.result = 'no';
      Connection.query('SELECT * FROM `backgammon_setting` LIMIT 1')
        .then(results => {
          ret.setting = results[0];
          response.send(ret)
        });
    });
});

server.listen(port);

console.log(`Listening on http://localhost:${port}`)