class STPeers extends EventTarget {
    static peerId = null;

    // Firestore
    #db;

    // Key of the stream peers are connected to
    #channel;

    #messages;

    #connections = [];

    #criteria;

    #stopListening;

    #blacklisted = {};

    constructor(db, channel) {
        super();

        this.#db = db;
        this.#channel = channel;
        //this.#peerId = window.crypto.randomUUID();
        this.#criteria = new STPeerCriteria();
        this.#messages = new STMessages(this.peerId, this.ref);
    }

    get ref() {
        return this.#db.collection("channels")
            .doc(this.#channel).collection("peers");
    }

    get peerId() {
        if (!STPeers.peerId)
            STPeers.peerId = firebase.auth().currentUser.uid;
        
        return STPeers.peerId;
    }

    listen() {
        this.#messages.listen();
        this.#messages.addEventListener("message", (ev) => {
            var msg = ev.detail;

            // Added filter for messages from myself.  Not sure if I want to
            // filter all of them or just the offers I'm putting out.
            if (msg.from != this.peerId && (
                msg.to == this.peerId ||
                msg.to == STMessages.All)) 
            {
                this.dispatchEvent(new CustomEvent(msg.type, { "detail": msg }));
            }
        });
    }

    reload() {
        this.#stopListening();
        this.listen();
    }

    send(type, desc, to, replyTo) {
        return this.#messages.send(JSON.stringify(desc), type, to, replyTo);
    }

    sendChat(text, to) {
        return this.#messages.send(text, "chat", to);
    }

    sendStatus(report) {
        return this.#messages.send(JSON.stringify(report), "status");
    }

    addConnection(stc) {
        this.#connections.push(stc);
        this.#criteria.load = this.#connections.length;

        return this.#criteria.load;
    }

    removeConnection(stc) {
        var idx = this.#connections.indexOf(stc);
        this.#connections.splice(idx, 1);
        console.log(`Removed ${stc.remotePeerId} from connections.`,
            `There are now ${this.#connections.length}.`);
    }

    cleanConnections() {
        for (var i=0; i<this.#connections.length; i++) {
            if (this.#connections[i].connectionState == "failed") {
                console.log(`Found lingering failed connection.  Cleaning.`);
                this.#connections.splice(i, 1);
                i--;
            }
        }
    }

    disconnect(context='video', type='offer') {
        for (var i=0; i<this.#connections.length; i++) {
            var con = this.#connections[con];

            if (con.context==context && con.type==type) {
                console.log(`Disconnecting ${con.remotePeerId}.`);
                con.disconnect();
                this.#connections.splice(i, 1);
                i--;
            }
        }
    }

    get load() { return this.#criteria.load; }

    getLastConnectionPeerId() {
        if (this.#connections.length > 0)
            return this.#connections[this.#connections.length-1].remotePeerId;

        return null;
    }

    blacklist(peerId) {
        this.#blacklisted[peerId] = true;
    }

    addDataChannel(remotePeerId, dataConnection) {
        this.#messages.addDataChannel(remotePeerId, dataConnection);
    }

    stop() {
        this.#messages.stop();
        this.forEach((con) => { con.disconnect(); });
        this.#connections = [];
    }

    forEach(cb) {
        this.#connections.forEach(cb);
    }

    isConnectedTo(peerId) {
        for (var con of this.#connections) {
            if (con.remotePeerId == peerId)
                return true;
        }

        return false;
    }

    getConnectionById(connectionId) {
        for (var con of this.#connections) {
            console.log(`${con.connectionId} == ${connectionId}`);
            if (con.connectionId == connectionId)
                return con;
        }

        return null;
    }

    getConnectionByOfferId(offerId) {
        for (var con of this.#connections) {
            if (con.offerMessage) {
                if (con.offerMessage.id == offerId)
                    return con;
            }
        }

        return null;
    }
}