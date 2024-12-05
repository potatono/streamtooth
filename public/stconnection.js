// Abtracts PeerConnection and IceCandidates.  Collects IceCandidates until a threshold timeout
// is reached, then triggers a event iceComplete to indicate having a full collection.
class STConnection extends EventTarget {
    static iceServerRestUrl = "https://jplt.metered.live/api/v1/turn/credentials?apiKey=859b39cc0d353464345498af68d84df33fd5";
    static iceServers;

    // Connection Id of this connection, currently the id of the offer message
    connectionId;

    // PeerConnection
    #pc;

    // IceCandidates
    #ice;

    // Data channel for chat and post-bootstrap messaging
    #dc;

    // Timer for determining when ice negotiations are over
    #timer;

    // Type of connection offer/answer
    type;

    // Context of connection, video or data
    context;

    // Flag for whether we've sent iceComplete 
    // (some browsers take a long time to send the final null iceCandidate)
    #iceCompleteDispatched = false;

    //#remoteDescriptionSet = false;

    peerId;
    // Id of the remote peer
    remotePeerId;

    #stats;
    #statsTimer;

    #offerMessage;
    #answerMessage;
    
    constructor() { 
        super();
        // TODO Pass explicitly.
        this.peerId = STPeers.peerId;
    }

    get localDescription() {
        return this.#pc.localDescription;
    }

    get remoteDescription() {
        return this.#pc.remoteDescription;
    }

    get offerMessage() {
        return this.#offerMessage;
    }

    get answerMessage() {
        return this.#answerMessage;
    }

    get connectionState() {
        return (this.#pc && this.#pc.connectionState) || "disconnected";
    }

    get dataChannel() {
        return this.#dc;
    }
    
    async getIceServers() {
        if (!STConnection.iceServers) {
            const response = await fetch(STConnection.iceServerRestUrl);
            var iceServers = await response.json();
            // Filter out TURN servers for now.
            STConnection.iceServers = iceServers.filter((o) => o.urls.startsWith("stun:"));
        }

        return STConnection.iceServers;
    }

    async setup(stream) {
        this.connectionId = (new Date()).getTime();
        this.remotePeerId = null;
        this.#iceCompleteDispatched = false;

        const iceServers = await this.getIceServers();
        this.#pc = new RTCPeerConnection({ 'iceServers': iceServers });
        
        this.#ice = [];

        this.#pc.addEventListener("icecandidate", (ev) => { this.registerCandidate(ev.candidate); });
        this.#pc.addEventListener("track", (ev) => { this.dispatchTrack(ev); });
        this.#pc.addEventListener("connectionstatechange", (ev) => {this.dispatchStateChange(ev); });
        this.#pc.addEventListener("datachannel", (ev) => { this.setupDataChannel(ev.channel); })

        if (stream) {    
            console.log("Adding stream tracks..");
            for (var track of stream.getTracks()) {
                this.#pc.addTrack(track, stream);
            }
            this.context = this.context || 'video';
        }
        else {
            this.context = this.context || 'data';
        }
    }

    // When IceCandidates come in we start/restart a timer, when the timer goes off
    // we assume no more candidates are coming and fire the iceComplete pseudo-event
    registerCandidate(candidate) {
        //console.log("Got ice candidate..");
        this.#ice.push(candidate);

        if (this.#timer)
            clearTimeout(this.#timer);

        // TODO Don't love this
        const fireEvent = () => { 
            if (!this.#iceCompleteDispatched) {
                this.#iceCompleteDispatched = true;
                console.log("Dispatching iceComplete");
                
                this.dispatchEvent(new CustomEvent("iceComplete", { "detail": { 
                    "ice": this.#ice, 
                    "desc": this.#pc.localDescription,
                    "pc": this.#pc, 
                    "stc": this 
                }}));
            }
        };

        // If we have an empty candidate then that signals end of candidates
        if (!candidate) {
            console.log("ICE Candidate was null, firing complete");
            fireEvent();
        }
        else {
            // Otherwise wait for a full second of silence
            this.#timer = setTimeout(fireEvent, 1000);
        }
    }

    dispatchTrack(ev) {
        this.dispatchEvent(new CustomEvent("track", { "detail": ev })); 
    }

    dispatchStateChange(ev) {
        //this.#remoteDescriptionSet = false;
        this.dispatchEvent(new CustomEvent("stateChange", { "detail": ev}));
    }

    // getConnectionInfo() {
    //     return {
    //         "desc": this.#pc.localDescription,
    //         "ice": this.#ice
    //     }
    // }

    async createOffer(context="video") {
        this.type = "offer";
        this.context = context;

        if (context == "video") {
            this.#pc.addTransceiver('video',{'direction':'sendrecv'});
            this.#pc.addTransceiver('audio',{'direction':'sendrecv'});
        }

        this.setupDataChannel(this.#pc.createDataChannel(this.peerId));

        var offer = await this.#pc.createOffer();
        offer.context = context;

        await this.#pc.setLocalDescription(offer);

        return offer;
    }

    async createAnswer() {
        this.type = "answer";

        var answer = await this.#pc.createAnswer();

        await this.#pc.setLocalDescription(answer);

        return answer;
    }

    async connectRemote(message) {
        var description;

        this.remotePeerId = message.from;

        if (message.type == "offer") {
            this.#offerMessage = message;
            description = message.offer || JSON.parse(message.text);
        }
        else if (message.type == "answer") {
            this.#answerMessage = message;
            // chooseAnswer in main class already parses to get load parameters.
            description = message.answer || JSON.parse(message.text);
        }
        else {
            console.log(`Invalid message type in connectRemote ${message.type}`);
            return;
        }

        await this.#pc.setRemoteDescription(description);
    }

    setMessage(type, message) {
        if (type == "offer")
            this.#offerMessage = message;
        else if (type == "answer")
            this.#answerMessage = message;
    }

    setupDataChannel(channel) {
        console.log("Setting up data channel");
        if (!this.#dc)
            this.#dc = channel;

        this.#dc.addEventListener("open", (ev) => { this.dispatchDataChannel(); });
    }

    dispatchDataChannel() {
        console.log("STC dispatchDataChannel")
        this.dispatchEvent(new CustomEvent("datachannel", { "detail": { 'dc': this.#dc, 'stc': this } }));
    }

    sendMessage(msg) {
        if (this.#dc && this.#dc.readyState == "open") {
            this.#dc.send(JSON.stringify(msg))
        }
    }

    disconnect() {
        if (this.#dc) {
            this.#dc.close();
            this.#dc = null;
        }

        if (this.#pc) {
            this.#pc.close();
            this.#pc = null;
        }

        if (this.#statsTimer) {
            window.clearTimeout(this.#statsTimer);
            this.#statsTimer = null;
        }
    }

    requestStats(type='inbound-rtp') {
        this.#pc.getStats().then((stats) => { 
            stats.forEach((report) => {
                if (report.type == type && report.kind == 'video') {
                    this.#stats = report;

                    return report;
                }
            });
        });
    }

    startStats(type) {
        console.log("Starting stats collection");
        this.#statsTimer = window.setInterval((type) => { this.requestStats(type) }, 1000, type);
    }

    getReport() {
        var report = {
            connectionId: this.connectionId,
            peerId: this.peerId,
            remotePeerId: this.remotePeerId,
            type: this.type,
            context: this.context,
            state: this.connectionState,
            offerMessage: this.#offerMessage,
            answerMessage: this.#answerMessage
        };

        if (this.#stats) {
            report['fps'] = this.#stats.framesPerSecond;
            report['width'] = this.#stats.frameWidth;
            report['height'] = this.#stats.frameHeight;
            report['packets'] = this.#stats.packetsReceived;
            report['timestamp'] = this.#stats.timestamp;
            report['lastReceivedTimestamp'] = this.#stats.lastPacketReceivedTimestamp; 
            report['stats'] = this.#stats;
        }

        return report;
    }
}