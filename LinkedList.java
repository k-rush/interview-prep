
public class LinkedList {
	Node head = null;

	public LinkedList(int d) {
		head = new Node(d);
	}

	public void append(int d) {
		head.appendToTail(d);
	}

	public String toString() {
		StringBuilder returnString = new StringBuilder();
		Node n = head;
		while(n != null) {
			returnString.append(n.toString() + " -> ");
			n = n.next;
		}
		returnString.append("END");

		return returnString.toString();
	}

}