class STBase extends EventTarget {
    static #levels = {'debug':1,'info':2,'warn':3,'error':4};
    static #level = 'info';
    static #logs = {
        size: 0,
        shippedOn: (new Date().getTime()) - 50000,
        lines: []
    };

    static #db = null;
    static channel = window.location.hash.replace(/^#/, "");

    static get peerId() {
        return firebase.auth().currentUser.uid;
    }

    static async db() {
        if (!STBase.#db) {
            STBase.#db = await firebase.firestore();
        }

        return STBase.#db;
    }

    static setLogLevel(level) {
        if (level in STBase.#levels)
            STBase.#level = level;
    }

    async logRef() {
        var db = await STBase.db();
        var key = (new Date().getTime()) + "." + window.performance.now();

        return db.collection("channels")
        .doc(STBase.channel).collection("logs")
        .doc(STBase.peerId).collection("entries")
        .doc(key);
    }

    log(level, msg) {
        if (STBase.#levels[level] < STBase.#levels[STBase.#level])
            return;

        var sender = this.constructor.name;
        var expanded = `[${sender}:${level}] ${msg}`;
        console.log(expanded);

        STBase.#logs.size += expanded.length;
        STBase.#logs.lines.push(expanded);
    }

    shouldShipLogs() {
        return (new Date().getTime()) - STBase.#logs.shippedOn > 60000 ||
            STBase.#logs.size > 750000; 
    }

    createLogShipment() {
        var startTime = STBase.#logs.shippedOn;
        var text = STBase.#logs.lines.join("\n");
        STBase.#logs.lines = [];
        STBase.#logs.shippedOn = (new Date().getTime());
        STBase.#logs.size = 0;
        return { "startTime": startTime, "text": text };
    }

    debug(msg) {
        this.log('debug', msg);
    }

    info(msg) {
        this.log('info', msg);
    }

    warn(msg) {
        this.log('warn', msg);
    }

    error(msg) {
        this.log('error', msg);
    }
}