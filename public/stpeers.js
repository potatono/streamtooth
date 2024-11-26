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

    addConnection(msg) {
        this.#connections.push(msg);
        this.#criteria.load = this.#connections.length;
    }

    getLastConnectionPeerId() {
        if (this.#connections.length > 0)
            return this.#connections[this.#connections.length-1]['from']

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
    }
}