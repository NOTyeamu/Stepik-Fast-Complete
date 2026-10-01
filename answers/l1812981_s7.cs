using System;

public class MainClass
{
    public static void Main()
    {
        // put your c# code here
        string input = Console.ReadLine();
        if (input != null)
        {
            int number = int.Parse(input);
            int cube = number * number * number;
            Console.WriteLine(cube);
        }
    }
}