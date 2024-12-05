class STMessages extends EventTarget {
    static All = "*";

    // RTCDataChannels
    #dcs = [];

    // Firestore collection reference
    #col;

    // Function called to stop listening to the collection.
    #stopListen;

    // My peer id
    #peerId;

    // Message receipt queue/lookup, a fixed max-length queue of messages received
    // used for duplicate detection
    #receiptQueueLength = 30;
    #receiptQueue = [];
    #receiptLookup = {};

    constructor(peerId, colRef) {
        super();
        this.#peerId = peerId;
        this.#col = colRef;
    }

    listen() {
        this.#stopListen = this.#col.onSnapshot((snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type == "added") {
                    this.receivedMessage(this.fromFirestore(change.doc.data()));
                }
            });
        })
    }

    stop() {
        this.#stopListen();
        
        for (var peerId in this.#dcs) {
            this.#dcs[peerId].close();
        }
    }

    addDataChannel(dc) {
        console.log("Adding data channel");
        this.#dcs.push(dc);

        dc.addEventListener("closing", (ev) => { 
            console.log("DataChannel is closing.");
            this.removeDataChannel(ev.channel); 
        });
        dc.addEventListener("close", (ev) => { 
            console.log("DataChannel has closed.");
            this.removeDataChannel(ev.channel); 
        });
        dc.addEventListener("message", (ev) => {
            var msg = JSON.parse(ev.data);
            this.receivedMessage(msg, dc);
        });
    }

    removeDataChannel(dc) {
        var idx = this.#dcs.indexOf(dc);
        this.#dcs.splice(idx, 1);
    }

    checkIsNotDuplicate(message) {
        var key = message.id;

        if (key in this.#receiptLookup) 
            return false;

        var newLength = this.#receiptQueue.push(key);
        this.#receiptLookup[key] = true;

        if (newLength > this.#receiptQueueLength) {
            var key = this.#receiptQueue.shift();
            delete this.#receiptLookup[key];
        }

        return true;
    }

    receivedMessage(message, dataChannel=null) {
        if (this.checkIsNotDuplicate(message)) {
            if (message.to == STMessages.All || message.to == this.#peerId) {
                this.dispatchEvent(new CustomEvent("message", { "detail": message }));
            }
        
            this.sendMessageToDataChannels(message, dataChannel);
        }
    }

    sendMessageToDataChannels(message, excludedChannel=null) {
        for (var dc of this.#dcs) {
            if (dc.readyState == "open" && dc != excludedChannel) {
                console.log("Sending via dataChannel", dc.label);
                dc.send(JSON.stringify(message));
            }
        }
    }

    toFirestore(message) {
        return {
            '_0_id': message['id'],
            '_1_replyTo': message['replyTo'],
            '_2_timestamp': firebase.firestore.Timestamp.now(),
            '_3_from': message['from'],
            '_4_to': message['to'],
            '_5_type': message['type'],
            '_6_text': message['text']
        };
    }

    fromFirestore(message) {
        return {
            'id': message['_0_id'],
            'replyTo': message['_1_replyTo'],
            'timestamp': message['_2_timestamp'],
            'from': message['_3_from'],
            'to': message['_4_to'],
            'type': message['_5_type'],
            'text': message['_6_text']
        };
    }

    sendMessageToCollection(message) {
        const validTypes = { "offer":1, "answer":1, "status":1 };

        if (message.type in validTypes) {
             this.#col.add(this.toFirestore(message));
        }
    }

    sendMessage(message) {
        console.log("Sending message", message.id, message.type, message.from, message.to);
        this.sendMessageToDataChannels(message);
        this.sendMessageToCollection(message);
    }

    createMessageId() {
        // TODO Add in detection of clock drift using server timestamps
        return (new Date()).getTime();
    }

    send(text, type="chat", to=null, replyTo=null) {
        var id = this.createMessageId();
        to = to || STMessages.All;

        var message = {
            "from": this.#peerId,
            "to": to,
            "type": type,
            "id": id,
            "text": text,
            "replyTo": replyTo
        };

        this.sendMessage(message);

        return message;
    }
}