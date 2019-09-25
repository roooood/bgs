var colyseus = require('colyseus'),
    Connection = require('./connection'),
    request = require('request'),
    BigNumber = require('bignumber.js')

class metaData {
    constructor(data) {
        this.round = 1;
        this.bet = data.bet;
        this.ready = 0;
        this.viewer = 0;
        this.timing = 30000;
        this.p1 = '';
        this.p2 = '';
    }
}

class State {
    constructor() {
        this.started = false;
        this.gameStatus = 80;
        this.points = Array(24).fill({
            player: false,
            checkers: 0
        });
        this.p1IsNext = true;
        this.Sit = {};
        this.history = [];
        this.currentPosition = 0;
        this.dice = [0];
        this.grayBar = {
            checkersP1: 0,
            checkersP2: 0
        };
        this.outSideBar = {
            checkersP1: 15,
            checkersP2: 15
        };
        this.movingChecker = false;
    }
}
class Server extends colyseus.Room {
    constructor(options) {
        super(options);
        this.timing = 30000;
        this.autoTiming = 10000;
        this.dispose = 'nothing';
        this.commission = 10;
        this.player = 2;
        this.turn = 0;
        this.first = true;
        this.isAuto = false;
        this.started = false;

        this.rollDiceHandler = this.rollDiceHandler.bind(this);
        this.autoMove = this.autoMove.bind(this);
        this.autoReceive = this.autoReceive.bind(this);
        this.close = this.close.bind(this);

    }
    async onInit(options) {
        this.meta = {};
        this.setState(new State);
        await Connection.query('SELECT * FROM `backgammon_setting` LIMIT 1')
            .then(results => {
                let res = results[0];
                this.timing = res.timing * 1000;
                this.autoTiming = res.autotiming * 1000;
                this.commission = res.commission;
                this.dispose = res.dispose;
            });

    }
    requestJoin(options, isNewRoom) {

        if (options.create && isNewRoom) {
            this.meta = new metaData({
                bet: options.bet
            });
            this.setMetadata(this.meta);
        }
        return (options.create) ?
            (options.create && isNewRoom) :
            this.clients.length > 0;
    }
    async onAuth(options) {
        let ret;
        await Connection.query('SELECT * FROM `users` LEFT JOIN `wallets` ON `users`.`token` = `wallets`.`token` where `users`.`token`=? LIMIT 1', [options.key])
            .then(results => {
                ret = {
                    id: results[0].userId,
                    name: results[0].username,
                    balance: results[0].balance,
                    level: 1
                };
                if (results[0].balance < this.meta.bet)
                    ret = false;
            }, e => {
                ret = false;
            });
        return ret;
    }
    onJoin(client, options, auth) {
        client.id = auth.id;
        client.name = auth.name;
        client.level = auth.level;
        if (this.started) {
            for (let i of Object.keys(this.state.Sit)) {
                if (this.state.Sit[i].id == client.id) {
                    this.addPlayer(client, this.state.Sit[i].sit);
                    break;
                }
            }
        }
        else {
            if (this.first) {
                this.addPlayer(client, '1');
            } else {
                this.addPlayer(client, (this.state.Sit['1'] == null ? '1' : '2'));
            }
            this.first = false;
        }

        this.checkJoinRules(client);
        this.send(client, {
            welcome: {
                ...this.meta,
                time: this.timing
            }
        });
    }

    onMessage(client, message) {
        var type = Object.keys(message)[0];
        var value = message[type];
        switch (type) {
            case 'rollDice':
                if (client.sit == this.turn) {
                    this.clearTimer();
                    this.rollDiceHandler(false);
                }
                break;
            case 'move':
                if (client.sit == this.turn && !this.isAuto) {
                    this.clearTimer();
                    this.moveCheckerHandler(value);
                }
                break;
            case 'undo':
                if (client.sit == this.turn && !this.isAuto) {
                    this.undoHandler()
                }
                break;
            case 'receive':
                if (client.sit == this.turn && !this.isAuto) {
                    this.clearTimer();
                    this.receiveCheckerHandler(value);
                }
                break;
        }
    }

    onLeave(client, consented) {
        if (this.started) {
            if (consented) {
                this.giveUp(client);
            } else {
                this.disconnected(client);
            }
        } else {
            this.leave(client);
        }
    }
    onDispose() {

    }


    checkJoinRules(client) {
        var i;
        for (i in this.clients) {
            if (this.clients[i].id == client.id && client.sessionId != this.clients[i].sessionId) {
                this.clients[i].close();
            }
        }
    }

    addPlayer(client, sit) {
        this.removePlayer(client);
        if (this.state.Sit[sit] == null) {
            client.sit = sit;

            if (sit == '1') {
                this.meta.p1 = client.name;
            } else {
                this.meta.p2 = client.name;
            }
            this.setMetadata(this.meta);
            this.clock.setTimeout(() => {
                this.state.Sit[sit] = {
                    id: client.id,
                    name: client.name,
                    level: client.level,
                    sit: sit,
                    timing: this.timing
                };
                this.setClientReady();
            }, 500);
            this.canStart();
            return true;
        } else if (this.state.Sit[sit].disconnected == true && this.state.Sit[sit].id == client.id) {
            client.sit = sit;
            this.broadcast({
                connected: client.name
            });
            this.clock.setTimeout(() => {
                this.state.Sit[sit] = {
                    id: client.id,
                    name: client.name,
                    level: client.level,
                    sit: sit,
                    timing: this.timing
                };
            }, 400);
            return true;
        }
        return false;

    }

    removePlayer(client) {
        if (client.sit > 0) {
            delete this.state.Sit[client.sit];
            this.setClientReady();
        }
    }
    canStart() {
        if (this.timer != undefined)
            this.timer.clear();
        this.timer = this.clock.setTimeout(() => {
            if (this.meta.ready == this.player) {
                this.start()
            }
        }, 600);
    }



    clientBySit(id) {
        var ret = -1,
            client;
        for (client of this.clients) {
            if (client.sit == id) {
                ret = client;
                break;
            }
        }
        return ret;
    }
    setClientReady() {
        this.meta.ready = Object.keys(this.state.Sit).length;
        this.setMetadata(this.meta);
    }
    random(min, max) {
        return Math.floor(Math.random() * max) + min;
    }

    setTimer(callBack, timing) {
        if (timing < 0) {
            timing = this.isAuto ? 1000 : this.timing / 2;
        }
        this.timer = this.clock.setTimeout(() => callBack(true), timing);
        var tm = timing / 1000;
    }
    clearTimer() {
        if (this.timer != undefined) {
            this.timer.clear();
        }
    }


    randomRegnant() {
        return this.random(1, this.player);
    }
    start() {
        this.started = true;;
        this.setupNewGameHandler();
    }

    giveUp(loser) {
        if (!this.started)
            return;
        let next = loser.sit == 1 ? 2 : 1;
        this.state.gameStatus = next == 1 ? 60 : 70;
        let winner = this.clientBySit(next);
        this.gameDone(winner.id, loser.id);
        this.resetGame();
    }
    gameDone(winner, losser) {
        let bet = this.meta.bet;
        let date = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
        let point = {
            bet, commission: this.commission, time: date
        }
        Connection.query('INSERT INTO `backgammon_points` SET ?', point)
            .then(results => {
                Connection.query('SELECT LAST_INSERT_ID() AS `last_id` ')
                    .then(result => {
                        let id = result[0]['last_id'];
                        this.result(id, winner, losser);
                    });
            });
    }
    result(id, winner, losser) {
        let bet = this.meta.bet;
        let commission = this.commission < 100 && this.commission > 1 ? (bet * this.commission) / 100 : this.add(bet, - this.commission);
        let winbet = this.add(bet, - commission);

        let win = {
            pid: id,
            uid: winner,
            cash: winbet,
            type: 'win'
        }
        let lose = {
            pid: id,
            uid: losser,
            cash: bet,
            type: 'lose'
        }
        Connection.query('INSERT INTO `backgammon_result` SET ?', win);
        let wuser = this.userBySit(id);
        this.updateUserBalance(winner, wuser > -1 ? this.clients[wuser] : 0, winbet);

        Connection.query('INSERT INTO `backgammon_result` SET ?', lose);
        let luser = this.userBySit(id);
        this.updateUserBalance(losser, luser > -1 ? this.clients[luser] : 0, -bet)
    }
    userBySit(sit) {
        let i;
        for (i in this.clients) {
            if (this.clients[i].sit == sit) {
                return i;
            }
        }
        return -1;
    }
    disconnected(client) {
        if (this.state.Sit[client.sit] != null) {
            this.state.Sit[client.sit].disconnected = true;
            this.broadcast({
                disconnected: client.name
            });
        }
    }

    leave(client) {
        this.removePlayer(client);
        this.resetGame();
    }

    resetGame() {
        this.started = false;
        this.clearTimer();
        this.setTimer(this.close, 1000);
    }

    close() {
        let i;
        for (i in this.clients) {
            this.clients[i].close();
        }
    }


    setupNewGameHandler() {
        this.turn = this.randomRegnant();

        const p1IsNext = this.turn == 1;
        const gameStatus = 11;
        const history = [];
        const currentPosition = 0
        const dice = [0];
        const points = Array(24).fill({
            player: false,
            checkers: 0
        });
        const grayBar = {
            checkersP1: 0,
            checkersP2: 0
        };
        const outSideBar = {
            checkersP1: 0,
            checkersP2: 0
        };
        const movingChecker = false;

        history.push(this.setHistory(p1IsNext, dice, points, grayBar, outSideBar));

        points[0] = {
            player: 1,
            checkers: 2
        };
        points[11] = {
            player: 1,
            checkers: 5
        };
        points[16] = {
            player: 1,
            checkers: 3
        };
        points[18] = {
            player: 1,
            checkers: 5
        };

        points[23] = {
            player: 2,
            checkers: 2
        };
        points[12] = {
            player: 2,
            checkers: 5
        };
        points[7] = {
            player: 2,
            checkers: 3
        };
        points[5] = {
            player: 2,
            checkers: 5
        };


        let state = {
            started: true,
            p1IsNext: p1IsNext,
            gameStatus: gameStatus,
            history: history,
            currentPosition: currentPosition,
            dice: dice,
            grayBar: grayBar,
            outSideBar: outSideBar,
            movingChecker: movingChecker,
            points: points,
        };
        Object.entries(state).forEach(([key, item]) => {
            this.state[key] = item;
        });
        this.setTimer(this.rollDiceHandler, this.timing);
    }
    setHistory(p1IsNext, dice, points, grayBar, outSideBar, gameStatus) {
        const history = {
            p1IsNext: p1IsNext,
            dice: [...dice],
            points: [...points],
            grayBar: {
                ...grayBar
            },
            outSideBar: {
                ...outSideBar
            },
            gameStatus: gameStatus,
        }
        return history;
    }
    rollDiceHandler(isAuto = isAuto) {
        this.isAuto = isAuto;
        this.state.Sit[this.turn].timing = isAuto ? this.autoTiming : this.timing;
        const p1IsNext = this.state.p1IsNext;

        const dice = [];
        dice.push(Math.floor(Math.random() * 6) + 1);
        dice.push(Math.floor(Math.random() * 6) + 1);
        if (dice[0] === dice[1]) {
            dice[2] = dice[3] = dice[0];
        }


        const moves = this.calculateCanMove(
            this.getPointsWithoutActions(this.state.points),
            dice,
            p1IsNext,
            this.state.grayBar
        );

        const points = moves.points;
        const gameStatus = moves.gameStatus;

        const currentPosition = 0;
        const history = [];
        history.push(this.setHistory(
            p1IsNext,
            dice,
            points,
            this.state.grayBar,
            this.state.outSideBar,
            gameStatus
        ));

        let state = {
            gameStatus: gameStatus,
            history: history,
            currentPosition: currentPosition,
            points: points,
            dice: dice,
            p1IsNext: p1IsNext,
        };
        Object.entries(state).forEach(([key, item]) => {
            this.state[key] = item;
        });
        this.setTimer(this.autoMove, -1);
    }
    calculateCanMove(points, dice, p1IsNext, grayBar) {

        let newPoints = [...points];
        let gameStatus = 50;

        if (!dice[0]) {
            gameStatus = 40;
        } else {
            if ((p1IsNext && grayBar.checkersP1) ||
                (!p1IsNext && grayBar.checkersP2)) {

                for (let die of dice) {
                    const destination = p1IsNext ? die - 1 : 24 - die;
                    if (points[destination].player === this.getPlayer(p1IsNext) ||
                        points[destination].checkers < 2) {
                        newPoints[destination].canReceive = die;
                        gameStatus = 31;
                    }
                }
            } else {

                const inHomeBoard = this.checkHomeBoard(newPoints, p1IsNext);

                for (let index = 0; index < points.length; index++) {

                    let canMove = false;

                    if (points[index].player === this.getPlayer(p1IsNext)) {
                        for (let die of dice) {

                            const destination = p1IsNext ? index + die : index - die;
                            if (!canMove && destination < 24 && destination >= 0) {
                                if (points[destination].player === this.getPlayer(p1IsNext) ||
                                    points[destination].checkers < 2) {
                                    canMove = true;
                                    gameStatus = 30;
                                }
                            }
                        }
                    }


                    if (inHomeBoard && ((p1IsNext && index >= 18) || (!p1IsNext && index <= 5))) {

                        if (this.checkCanBearOff(points, index, p1IsNext, dice)) {
                            canMove = true;
                            gameStatus = 32;
                        }
                    }

                    if (canMove) {
                        newPoints[index].canMove = index;
                    }
                }
            }
        }

        if (gameStatus == 50) {
            this.clock.setTimeout(() => {
                this.noMove();
            }, 2000)
        }
        return {
            points: points,
            gameStatus: gameStatus
        };
    }
    noMove() {
        this.clearTimer();
        this.turn = this.turn == 1 ? 2 : 1;
        let state = {
            p1IsNext: !this.state.p1IsNext,
            dice: [0],
            gameStatus: 20
        }
        Object.entries(state).forEach(([key, item]) => {
            this.state[key] = item;
        });
        let time = this.state.Sit[this.turn].timing;
        this.setTimer(this.rollDiceHandler, time);
    }
    checkHomeBoard(points, p1IsNext) {

        let homeBoard = true;

        points.map((point, index) => {

            if (p1IsNext && index <= 17 &&
                point.player === 1
            ) {
                homeBoard = false;
            } else if (!p1IsNext && index >= 6 &&
                point.player === 2
            ) {
                homeBoard = false;
            }

            return null;

        });

        return homeBoard;

    }
    checkCanBearOff(points, checker, p1IsNext, dice) {

        let canBearOff = false;

        if (checker >= 0 && checker < 24 && points[checker].player === this.getPlayer(p1IsNext)) {

            for (let die of dice) {
                if ((p1IsNext && (checker + die) === 24) || (!p1IsNext && (checker - die) === -1)) {
                    canBearOff = die;
                }
            }

            if (!canBearOff) {

                const highDie = [...dice].sort().reverse()[0];
                let checkerBehind = false;

                if ((p1IsNext && (checker + highDie) > 24) || (!p1IsNext && (checker - highDie) < -1)) {

                    if (p1IsNext) {
                        for (let i = 18; i < checker; i++) {
                            if (points[i].player && points[i].player === this.getPlayer(p1IsNext)) {
                                checkerBehind = true;
                            }
                        }
                    } else {
                        for (let i = 5; i > checker; i--) {
                            if (points[i].player && points[i].player === this.getPlayer(p1IsNext)) {
                                checkerBehind = true;
                            }
                        }
                    }

                    if (!checkerBehind) {
                        canBearOff = highDie;
                    }
                }
            }
        }
        return canBearOff;
    }
    autoMove() {
        this.isAuto = true;
        let i, point;
        let c = this.state.p1IsNext ? 1 : 2;
        let receiver = 'checkersP' + c;

        if (this.state.grayBar[receiver] > 0) {
            for (point of this.state.points) {
                if ('canReceive' in point) {
                    this.receiveCheckerHandler(point.canReceive);
                    return;
                }
            }
        }
        if (this.state.p1IsNext) {
            for (i = 0; i < 24; i++) {
                if ('canMove' in this.state.points[i]) {
                    this.moveCheckerHandler(this.state.points[i].canMove)
                }
            }
        } else {
            for (i = 23; i >= 0; i--) {
                if ('canMove' in this.state.points[i]) {
                    this.moveCheckerHandler(this.state.points[i].canMove)
                }
            }
        }
    }
    moveCheckerHandler(checker) {
        let gameStatus = 30;
        const p1IsNext = this.state.p1IsNext;
        const outSideBar = this.getOutSideBarWithoutActions(this.state.outSideBar);
        let points = this.getPointsWithoutActions(this.state.points);

        const movingChecker = checker !== this.state.movingChecker ? checker : false;

        if (movingChecker !== false) {

            points[movingChecker].canMove = movingChecker;

            for (let die of this.state.dice) {

                const destination = p1IsNext ? movingChecker + die : movingChecker - die;
                if (destination < 24 && destination >= 0) {
                    if (points[destination].player === this.getPlayer(p1IsNext) ||
                        points[destination].checkers < 2) {
                        points[destination].canReceive = die;
                    }
                }
            }

            if (this.checkHomeBoard(points, p1IsNext) &&
                ((p1IsNext && movingChecker >= 18) || (!p1IsNext && movingChecker <= 5))) {

                let die = this.checkCanBearOff(points, movingChecker, p1IsNext, this.state.dice);
                if (die) {

                    if (p1IsNext) {
                        outSideBar.p1CanReceive = die;
                    } else {
                        outSideBar.p2CanReceive = die;
                    }
                    gameStatus = 32;
                }
            }

        } else {
            const moves = this.calculateCanMove(points, this.state.dice, this.state.p1IsNext, this.state.grayBar);
            points = moves.points;
            gameStatus = moves.gameStatus;
        }

        let state = {
            gameStatus: gameStatus,
            points: points,
            movingChecker: movingChecker,
            outSideBar: outSideBar,
        }

        Object.entries(state).forEach(([key, item]) => {
            this.state[key] = item;
        });

        this.setTimer(this.autoReceive, -1);
    }
    autoReceive() {
        this.isAuto = true;
        let i;
        for (i of this.state.points) {
            if ('canReceive' in i) {
                this.receiveCheckerHandler(i.canReceive);
                return;
            }
        }
        let c = this.state.p1IsNext ? 1 : 2;
        let receiver = 'p' + c + 'CanReceive';
        if (receiver in this.state.outSideBar) {
            this.receiveCheckerHandler(i[receiver]);
            return;
        }

    }
    receiveCheckerHandler(die) {
        const grayBar = {
            ...this.state.grayBar
        };
        const outSideBar = this.getOutSideBarWithoutActions(this.state.outSideBar);
        const dice = [...this.state.dice];
        let p1IsNext = this.state.p1IsNext;
        let gameStatus = 30;
        let setHandler = false;
        let points = this.getPointsWithoutActions(this.state.points);

        let movingChecker = this.getMovingChecker(p1IsNext);

        const destination = p1IsNext ? movingChecker + die : movingChecker - die;

        if (destination > 23 || destination < 0) { } else { }

        if (movingChecker >= 0 && movingChecker <= 23) {
            points[movingChecker].checkers--;

            if (points[movingChecker].checkers === 0) {
                points[movingChecker].player = false;
            }

        } else {
            if (movingChecker === -1) {
                grayBar.checkersP1--;
            } else if (movingChecker === 24) {
                grayBar.checkersP2--;
            }
        }

        if (destination <= 23 && destination >= 0) {
            if (points[destination].player === this.getPlayer(p1IsNext) ||
                points[destination].player === false) {

                points[destination].checkers++;
            } else {
                if (p1IsNext) {
                    grayBar.checkersP2++
                } else {
                    grayBar.checkersP1++
                }
            }
            points[destination].player = this.getPlayer(p1IsNext);
        } else {
            if (p1IsNext) {
                outSideBar.checkersP1++;
            } else {
                outSideBar.checkersP2++;
            }
        }

        movingChecker = false;

        const diceIndex = dice.findIndex((dieNumber) => dieNumber === die);
        dice.splice(diceIndex, 1);

        if (dice.length === 0) {
            dice[0] = 0;
            p1IsNext = !p1IsNext;
            setHandler = true;
        } else {
            const moves = this.calculateCanMove(points, dice, p1IsNext, grayBar);
            points = moves.points;
            gameStatus = moves.gameStatus;
            this.setTimer(this.autoMove, -1);
        }

        const currentPosition = this.state.currentPosition + 1;
        const history = [...this.state.history];
        history.push(this.setHistory(p1IsNext, dice, points, grayBar, outSideBar));

        if (outSideBar.checkersP1 === 15) {
            gameStatus = 90;
            this.clock.setTimeout(() => {
                this.giveUp(this.clientBySit(2));
            }, 800)
        } else if (outSideBar.checkersP2 === 15) {
            gameStatus = 90;
            this.clock.setTimeout(() => {
                this.giveUp(this.clientBySit(1));
            }, 800)
        }

        let state = {
            gameStatus: gameStatus,
            history: history,
            currentPosition: currentPosition,
            p1IsNext: p1IsNext,
            dice: dice,
            points: points,
            grayBar: grayBar,
            outSideBar: outSideBar,
            movingChecker: movingChecker,
        }
        Object.entries(state).forEach(([key, item]) => {
            this.state[key] = item;
        });
        //gameStatus == 50 || setHandler
        if (setHandler) {
            let time = this.state.Sit[this.turn].timing;
            this.turn = this.turn == 1 ? 2 : 1;
            this.setTimer(this.rollDiceHandler, time);
        }
    }
    getPlayer(p1IsNext) {
        return p1IsNext ? 1 : 2;
    }
    getPointsWithoutActions(points) {
        let newpoint = [];
        for (let point of points) {
            newpoint.push({
                player: point.player,
                checkers: point.checkers
            })
        }
        return newpoint;
    }
    getOutSideBarWithoutActions(outSideBar) {
        return {
            checkersP1: outSideBar.checkersP1,
            checkersP2: outSideBar.checkersP2
        }
    }
    getMovingChecker(p1IsNext) {
        let movingChecker;
        if (this.state.movingChecker !== false) {
            movingChecker = this.state.movingChecker;
        } else {
            if (p1IsNext) {
                movingChecker = -1;
            } else {
                movingChecker = 24;
            }
        }
        return movingChecker;
    }
    undoHandler() {

        const history = [...this.state.history];
        const newPosition = this.state.currentPosition - 1;
        const p1IsNext = history[newPosition].p1IsNext;
        const dice = [...history[newPosition].dice];
        const grayBar = {
            ...history[newPosition].grayBar
        };
        const outSideBar = {
            ...history[newPosition].outSideBar
        };
        const movingChecker = false;


        const moves = this.calculateCanMove(this.state.history[newPosition].points, dice, p1IsNext, grayBar);
        const points = moves.points;
        const gameStatus = moves.gameStatus;
        history.pop();

        let state = {
            gameStatus: gameStatus,
            history: history,
            currentPosition: newPosition,
            p1IsNext: p1IsNext,
            dice: dice,
            points: points,
            grayBar: grayBar,
            outSideBar: outSideBar,
            movingChecker: movingChecker
        };

        Object.entries(state).forEach(([key, item]) => {
            this.state[key] = item;
        });

    }
    updateUserBalance(id, balance, amount) {
        var user_token = "";
        return;
        Connection.query('SELECT * FROM `users` where `users`.`userId`=? LIMIT 1', [id])
            .then(results => {
                {
                    user_token = results[0].token;
                    var pid = 2;
                    var description;
                    var url = 'http://localhost:4822';
                    var won = 0;
                    var odd = 0;
                    var match_id = 0;

                    if (amount != 0) {
                        if (amount > 0) {
                            description = 'Backgammon win';
                        } else {
                            description = 'Backgammon start';
                        }

                        var options = {
                            method: 'POST',
                            url: url + '/api/webservices/wallet/change',
                            headers:
                            {
                                'cache-control': 'no-cache',
                                'x-access-token': user_token,
                                'content-type': 'multipart/form-data'
                            },
                            formData:
                            {
                                pid: pid,
                                user_token: user_token,
                                amount: amount,
                                description: description
                            }
                        };
                        request(options, function (error, response, body) {
                            if (error) throw new Error(error);
                        });

                        Connection.query('SELECT * FROM `dice_result` WHERE `uid` = ? ORDER BY `id` DESC LIMIT 1', [id])
                            .then(result => {
                                if (result[0] != null) {
                                    match_id = result[0].id;
                                    if (amount < 0) {
                                        //store bet

                                        won = -1;
                                        var form_data = {
                                            pid: pid,
                                            user_token: user_token,
                                            amount: amount,
                                            odd: 1,
                                            sport_name: 'backgammon',
                                            match_id: match_id,
                                            won: won,
                                            choice: '-'
                                        };
                                        var options = {
                                            method: 'POST',
                                            url: url + '/api/webservices/bet/store',
                                            headers: {
                                                'cache-control': 'no-cache',
                                                'x-access-token': user_token,
                                                'content-type': 'multipart/form-data'
                                            },
                                            formData: form_data
                                        };
                                        request(options, function (error, response, body) {
                                            if (error) throw new Error(error);
                                        });
                                    }
                                    else {
                                        //update bet

                                        won = 2;
                                        var form_data =
                                        {
                                            pid: pid,
                                            amount: amount,
                                            user_token: user_token,
                                            odd: 1,
                                            sport_name: 'backgammon',
                                            match_id: match_id,
                                            won: won,
                                        }
                                        var options = {
                                            method: 'POST',
                                            url: url + '/api/webservices/bet/update',
                                            headers: {
                                                'cache-control': 'no-cache',
                                                'x-access-token': user_token,
                                                'content-type': 'multipart/form-data'
                                            },
                                            formData: form_data
                                        };
                                        request(options, function (error, response, body) {
                                            if (error) throw new Error(error);
                                        });

                                    }
                                }
                            });
                    }

                }
            }, e => {

            });
    }
    add(a, b) {
        if (a < 1 || b < 1) {
            let c = new BigNumber(a);
            let f = b < 0 ? c.minus(-1 * b) : c.plus(b);
            return f.toNumber();
        }
        return (a + b);
    }
}



module.exports = Server;